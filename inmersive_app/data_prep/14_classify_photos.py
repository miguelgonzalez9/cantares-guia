#!/usr/bin/env python3
"""
14_classify_photos.py — Clasificador de fotos del Sistema de Información Cantares.
Motor LOCAL y gratuito ($0, offline): CLIP (categoría) + BioCLIP (especie).

Los papás sueltan TODAS las fotos, sin ordenar, en  Cantares/fotos/  (raíz).
Este script, por cada foto nueva:

  0. DEDUP     — hash del contenido; si ya existe, borra la duplicada.
  1. EXIF      — fecha + GPS.
  2. CLIP      — categoría gruesa (ave/planta/árbol/flor/mamífero/anfibio/insecto
                 / persona / infraestructura / paisaje). Si la confianza es baja
                 → _sin_clasificar. Las no-organismo se archivan aquí.
  3. ESPECIE   — para organismos (aves incluidas), en modo CERRADO contra el
                 inventario con BioCLIP (no puede devolver una especie fuera de la
                 reserva). Guardia anti-falso-positivo: solo asigna especie con
                 score + margen suficientes Y si CLIP y BioCLIP concuerdan de grupo.
                 Carpeta de la especie = NOMBRE COMÚN; el id del catálogo = científico.
  4. HÁBITO    — especie de flora → árbol (familias arbóreas) / flor (Orchidaceae)
                 / planta. Respeta un campo `habit` si existe.
  5. PUNTO     — atributo (no carpeta): si el GPS cae a ≤ radio de un waypoint de
                 la app (ground truth), punto=<id>; si no, null. No mueve el archivo.
  6. Registra todo en  fotos/catalog_fotos.json  y mueve la foto a su carpeta.

Principio: antes dejar sin clasificar que clasificar mal.

Uso:  python data_prep/14_classify_photos.py [--dry-run]
Requiere: Pillow + pybioclip + open_clip_torch (ver id_local.py). Sin API ni clave.
"""

import hashlib
import json
import math
import re
import shutil
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps, ExifTags

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# ---------- rutas ----------
ROOT = Path(__file__).resolve().parents[1]          # inmersive_app/
FOTOS = ROOT.parent / "fotos"                        # Cantares/fotos  (donde sueltan los papás)
CATALOG = FOTOS / "catalog_fotos.json"
DATA = ROOT / "app" / "public" / "data"
SPECIES_JSON = DATA / "species.json"
WAYPOINTS = DATA / "waypoints.geojson"

DRY = "--dry-run" in sys.argv

# ---------- parámetros (conservadores: antes sin clasificar que mal clasificado) ----------
CLIP_CONF_MIN = 0.35    # confianza mínima de CLIP para creer la categoría gruesa
SPECIES_MIN = 0.30      # score de BioCLIP para asignar especie (softmax sobre el inventario)
MARGIN_MIN = 0.08       # margen del 1º sobre el 2º candidato
PUNTO_RADIUS_M = 20     # radio para asociar la foto a un waypoint (por GPS)

# Categorías que NO son organismos (no van a BioCLIP; CLIP las resuelve).
NON_ORGANISM = {"visitante", "infraestructura", "paisaje"}
# grupo del inventario → carpeta de fauna (flora usa habit_folder)
GROUP_CAT = {"ave": "aves", "mamifero": "mamiferos", "anfibio": "anfibios"}
# categoría de CLIP → grupo esperado en el inventario. Si BioCLIP devuelve otro
# grupo, CLIP y BioCLIP NO concuerdan → no se confirma especie (anti-falso-positivo).
CAT_GROUP = {"planta": "flora", "arbol": "flora", "flor": "flora",
             "ave": "ave", "mamifero": "mamifero", "anfibio": "anfibio"}

CATEGORIES = ["plantas", "arboles", "flores", "aves", "mamiferos", "anfibios",
              "insectos", "paisaje", "infraestructura", "visitantes", "_sin_clasificar"]
VALID_EXT = {".jpg", ".jpeg", ".png", ".webp"}
HEIC_EXT = {".heic", ".heif"}

# Hábito por familia (alta confianza en el bosque montano andino). Ambiguo → plantas.
TREE_FAMILIES = {"Betulaceae", "Fagaceae", "Podocarpaceae", "Lauraceae", "Cunoniaceae",
                 "Juglandaceae", "Myrtaceae", "Cupressaceae", "Pinaceae", "Salicaceae",
                 "Clusiaceae", "Sabiaceae"}
FLOWER_FAMILIES = {"Orchidaceae"}

# Etiqueta de CLIP (singular) → carpeta de salida (plural).
CLIP_TO_FOLDER = {
    "ave": "aves", "mamifero": "mamiferos", "anfibio": "anfibios", "insecto": "insectos",
    "flor": "flores", "planta": "plantas", "arbol": "arboles",
    "visitante": "visitantes", "infraestructura": "infraestructura", "paisaje": "paisaje",
}


# ---------- utilidades ----------


def load_json(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def slug(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower() or "sp"


def common_dirname(rec, common_counts):
    """Carpeta de la especie con el NOMBRE COMÚN (legible). Si el común está vacío o
    se repite entre especies distintas, desambigua con el científico."""
    common = (rec.get("common_name") or "").strip()
    sci = (rec.get("scientific_name") or "").strip()
    if not common or common.lower() == sci.lower():
        return slug(sci)
    d = slug(common)
    if common_counts.get(common.lower(), 0) > 1:
        d = f"{d}__{slug(sci)}"
    return d


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def haversine(a, b):
    R = 6371000.0
    r = math.pi / 180
    dlat = (b[1] - a[1]) * r
    dlon = (b[0] - a[0]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[1] * r) * math.cos(b[1] * r) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


# ---------- EXIF ----------
_TAGS = {v: k for k, v in ExifTags.TAGS.items()}
_GPS = {v: k for k, v in ExifTags.GPSTAGS.items()}


def read_exif(path):
    """(fecha_iso|None, (lat,lon)|None)."""
    try:
        exif = Image.open(path).getexif()
    except Exception:
        return None, None
    if not exif:
        return None, None
    taken = exif.get(_TAGS.get("DateTimeOriginal")) or exif.get(_TAGS.get("DateTime"))
    date = None
    if taken:
        try:
            date = datetime.strptime(str(taken), "%Y:%m:%d %H:%M:%S").isoformat()
        except ValueError:
            pass
    latlon = None
    try:
        g = exif.get_ifd(ExifTags.IFD.GPSInfo)
        if g:
            def dms(v):
                d, m, s = [float(x) for x in v]
                return d + m / 60 + s / 3600
            lat = dms(g[_GPS["GPSLatitude"]])
            if g.get(_GPS["GPSLatitudeRef"], "N") in ("S", b"S"):
                lat = -lat
            lon = dms(g[_GPS["GPSLongitude"]])
            if g.get(_GPS["GPSLongitudeRef"], "E") in ("W", b"W"):
                lon = -lon
            latlon = (round(lat, 6), round(lon, 6))
    except Exception:
        pass
    return date, latlon


# ---------- inventario (conjunto CERRADO para BioCLIP) ----------
def build_closed_set():
    """Nombres científicos del inventario + suplemento (censo) y mapa norm(sci)→registro.
    BioCLIP se restringe a estos nombres: no puede devolver nada fuera de la reserva."""
    recs = [s for s in load_json(SPECIES_JSON).get("species", [])
            if s.get("group") in ("flora", "ave", "mamifero", "anfibio")]
    names, by_sci = [], {}
    for s in recs:
        k = (s.get("scientific_name") or "").strip()
        if k and k.lower() not in by_sci:
            by_sci[k.lower()] = s
            names.append(k)
    return names, by_sci


def species_folder(rec):
    """Carpeta de una especie según su grupo (flora → hábito árbol/planta/flor)."""
    if rec.get("group") == "flora":
        return habit_folder(rec)
    return GROUP_CAT.get(rec.get("group"), "_sin_clasificar")


def habit_folder(sp):
    h = (sp.get("habit") or "").lower()
    if h in ("arbol", "árbol", "arbusto"):
        return "arboles"
    if h in ("flor", "orquidea", "orquídea"):
        return "flores"
    if h:
        return "plantas"
    fam = sp.get("family", "")
    if fam in FLOWER_FAMILIES:
        return "flores"
    if fam in TREE_FAMILIES:
        return "arboles"
    return "plantas"


# ---------- puntos (GPS → waypoint) ----------
def load_waypoints():
    try:
        fc = load_json(WAYPOINTS)
    except FileNotFoundError:
        return []
    out = []
    for f in fc.get("features", []):
        p = f.get("properties", {})
        g = f.get("geometry", {})
        if p.get("id") and g.get("type") == "Point":
            out.append((p["id"], g["coordinates"]))   # (id, [lon,lat])
    return out


def nearest_punto(latlon, wps):
    if not latlon or not wps:
        return None, None
    lat, lon = latlon
    best_id, best_d = None, 1e18
    for wid, (wlon, wlat) in wps:
        d = haversine([lon, lat], [wlon, wlat])
        if d < best_d:
            best_id, best_d = wid, d
    if best_d <= PUNTO_RADIUS_M:
        return best_id, round(best_d, 1)
    return None, None


# ---------- decisión de categoría/especie (local: CLIP + BioCLIP) ----------
def decide(category, cscore, preds, by_sci):
    """category, cscore: CLIP.  preds: [(sci,score)] de BioCLIP (cerrado al inventario) o [].
    Devuelve (carpeta, species_dict|None, species_score, razon)."""
    folder = CLIP_TO_FOLDER.get(category, "_sin_clasificar")
    if cscore < CLIP_CONF_MIN:
        return "_sin_clasificar", None, 0.0, f"categoría incierta (CLIP {cscore:.2f})"
    if category in NON_ORGANISM:
        return folder, None, 0.0, "no-organismo (CLIP)"
    # organismo → BioCLIP sobre el conjunto cerrado del inventario
    if preds:
        top_sci, top_sc = preds[0]
        second = preds[1][1] if len(preds) > 1 else 0.0
        rec = by_sci.get((top_sci or "").lower())
        agree = rec and rec.get("group") == CAT_GROUP.get(category)
        if top_sc >= SPECIES_MIN and (top_sc - second) >= MARGIN_MIN and agree:
            return species_folder(rec), rec, top_sc, "especie confirmada (BioCLIP)"
        return folder, None, top_sc, "organismo, especie incierta (BioCLIP)"
    return folder, None, 0.0, "organismo, sin especie"


# ---------- principal ----------
def main():
    for c in CATEGORIES:
        (FOTOS / c).mkdir(parents=True, exist_ok=True)

    catalog = load_json(CATALOG) if CATALOG.exists() else {"photos": []}
    photos = catalog.setdefault("photos", [])
    seen = {p["hash"] for p in photos}

    names, by_sci = build_closed_set()
    common_counts = {}                       # nombre común → cuántas especies distintas lo usan
    for s in by_sci.values():
        c = (s.get("common_name") or "").strip().lower()
        if c:
            common_counts[c] = common_counts.get(c, 0) + 1
    wps = load_waypoints()

    # fotos nuevas = archivos sueltos en la RAÍZ de fotos/ (no en las subcarpetas)
    new = [f for f in sorted(FOTOS.glob("*"))
           if f.is_file() and f.suffix.lower() in VALID_EXT | HEIC_EXT]
    if not new:
        print(f"Sin fotos nuevas en {FOTOS.name}/. (Suelta fotos ahí y re-corre.)")
        return

    import id_local   # carga perezosa de los modelos (CLIP + BioCLIP) al 1er uso
    print(f"Cargando modelos locales (CLIP + BioCLIP, {len(names)} especies en el conjunto cerrado)…")

    n_species = n_general = n_unclass = n_dup = n_heic = n_punto = 0
    for f in new:
        if f.suffix.lower() in HEIC_EXT:
            n_heic += 1
            continue
        h = sha256(f)
        if h in seen:                        # DEDUP
            n_dup += 1
            if not DRY:
                f.unlink()
            continue
        seen.add(h)
        date, latlon = read_exif(f)
        punto, pdist = nearest_punto(latlon, wps)

        category, cscore = id_local.classify_category(f)          # CLIP (categoría gruesa)
        preds = []
        if cscore >= CLIP_CONF_MIN and category not in NON_ORGANISM:
            preds = id_local.identify_species(f, names)           # BioCLIP (cerrado al inventario)
        folder, sp, sscore, reason = decide(category, cscore, preds, by_sci)

        if sp:
            dest_dir = FOTOS / folder / common_dirname(sp, common_counts)   # carpeta = nombre común
            n_species += 1
        else:
            dest_dir = FOTOS / folder
            if folder == "_sin_clasificar":
                n_unclass += 1
            else:
                n_general += 1
        stem = f"{(date or '')[:10] or 'sinfecha'}_{h[:8]}"
        dest = dest_dir / f"{stem}{f.suffix.lower()}"
        if punto:
            n_punto += 1

        rec = {
            "hash": h, "file": None, "category": folder,
            "species_id": slug(sp["scientific_name"]) if sp else None,   # id = nombre científico
            "scientific_name": (sp["scientific_name"] if sp else (preds[0][0] if preds else "")),
            "clip_category": category, "clip_score": round(cscore, 3),
            "bioclip_score": round(sscore, 3),
            "punto": punto, "punto_dist_m": pdist,
            "date": date, "lat": latlon[0] if latlon else None, "lon": latlon[1] if latlon else None,
            "reason": reason,
        }
        if not DRY:
            dest_dir.mkdir(parents=True, exist_ok=True)
            shutil.move(str(f), str(dest))
            rec["file"] = str(dest.relative_to(FOTOS.parent)).replace("\\", "/")
        photos.append(rec)

    if not DRY:
        catalog["generated"] = datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
        CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"{'DRY-RUN — ' if DRY else ''}Clasificación de fotos (local: CLIP + BioCLIP, $0)")
    print(f"  Nuevas procesadas: {len(new) - n_heic}")
    print(f"    → especie confirmada: {n_species}")
    print(f"    → categoría general (especie/tipo incierto): {n_general}")
    print(f"    → _sin_clasificar/: {n_unclass}")
    print(f"    duplicadas borradas: {n_dup}")
    if n_heic:
        print(f"    HEIC omitidas (pasar a JPG): {n_heic}")
    print(f"  con atributo punto (GPS≤{PUNTO_RADIUS_M}m): {n_punto}")
    print(f"  Catálogo: fotos/catalog_fotos.json")


if __name__ == "__main__":
    main()
