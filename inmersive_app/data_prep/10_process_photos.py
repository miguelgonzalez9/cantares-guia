#!/usr/bin/env python3
"""
10_process_photos.py — Procesa las fotos de inputs/photos/incoming/ y las
integra al catálogo de imágenes de la app (app/public/data/media.json).

Qué hace, por cada foto en incoming/especies/<id>/ o incoming/puntos/<id>/:
  1. Valida <id> contra species.json / waypoints.geojson (avisa si no existe).
  2. Auto-orienta (EXIF), redimensiona a tamaño web y crea:
        app/public/img/{species|waypoints}/<id>__<n>.webp   (principal)
        app/public/img/{species|waypoints}/<id>__<n>.jpg    (respaldo)
        app/public/img/_thumbs/<id>__<n>.webp               (miniatura)
  3. Lee fecha (EXIF DateTimeOriginal) y GPS. Avisa si una foto de ESPECIE
     fue tomada fuera de la reserva (posible error de clasificación).
     Para especies marcadas como sensibles NO escribe lat/lon exactas.
  4. Mueve el original a inputs/photos/_originals/... (respaldo; no se versiona).
  5. Actualiza media.json conservando campos manuales (credit, caption, is_primary).

Uso:  python data_prep/10_process_photos.py [--dry-run]
Requiere: Pillow. (HEIC opcional: pip install pillow-heif)
"""

import json
import shutil
import sys
from pathlib import Path
from datetime import datetime

# La consola de Windows suele ser cp1252 y no encodea ✓/×/emojis. Fuerza UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

from PIL import Image, ImageOps, ExifTags

# ---------- rutas ----------
ROOT = Path(__file__).resolve().parents[1]                 # inmersive_app/
PUBLIC = ROOT / "app" / "public"
DATA = PUBLIC / "data"
INCOMING = ROOT / "inputs" / "photos" / "incoming"
ORIGINALS = ROOT / "inputs" / "photos" / "_originals"
IMG = PUBLIC / "img"
THUMBS = IMG / "_thumbs"

MEDIA_JSON = DATA / "media.json"
SPECIES_JSON = DATA / "species.json"
WAYPOINTS = DATA / "waypoints.geojson"
TRAILS = DATA / "trails.geojson"
ROUTES = DATA / "routes.json"

# ---------- parámetros de imagen ----------
FULL_MAX = 1600      # lado largo de la imagen principal (px)
THUMB_MAX = 420      # lado largo de la miniatura (px)
WEBP_Q = 80
JPG_Q = 82
THUMB_Q = 72
VALID_EXT = {".jpg", ".jpeg", ".png", ".webp"}
HEIC_EXT = {".heic", ".heif"}

# ---------- reserva (bbox algo holgado, EPSG:4326) ----------
RES_BBOX = dict(lon_min=-75.465, lon_max=-75.436, lat_min=5.070, lat_max=5.094)

# Especies sensibles adicionales (además del flag "sensitive": true en species.json).
# Sus coordenadas NO se publican (protección anti-saqueo de orquídeas, endémicas, etc.).
SENSITIVE_FALLBACK_FAMILIES = {"Orchidaceae"}

DRY = "--dry-run" in sys.argv


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def species_index():
    doc = load_json(SPECIES_JSON)
    idx = {}
    for s in doc.get("species", []):
        idx[s["id"]] = s
    return idx


def _feature_ids(path):
    try:
        fc = load_json(path)
    except FileNotFoundError:
        return set()
    ids = set()
    for f in fc.get("features", []):
        p = f.get("properties", {})
        if p.get("id"):
            ids.add(str(p["id"]))
    return ids


def waypoint_ids():
    return _feature_ids(WAYPOINTS)


def trail_ids():
    return _feature_ids(TRAILS)


def route_ids():
    try:
        doc = load_json(ROUTES)
    except FileNotFoundError:
        return set()
    return {str(r["id"]) for r in doc.get("routes", []) if r.get("id")}


# ---------- EXIF ----------
_EXIF_TAGS = {v: k for k, v in ExifTags.TAGS.items()}
_GPS_TAGS = {v: k for k, v in ExifTags.GPSTAGS.items()}


def read_exif(img):
    """Devuelve (taken_iso|None, (lat,lon)|None)."""
    taken, latlon = None, None
    try:
        exif = img.getexif()
    except Exception:
        return None, None
    if not exif:
        return None, None
    # fecha
    dto = exif.get(_EXIF_TAGS.get("DateTimeOriginal")) or exif.get(_EXIF_TAGS.get("DateTime"))
    if dto:
        try:
            taken = datetime.strptime(str(dto), "%Y:%m:%d %H:%M:%S").isoformat()
        except ValueError:
            pass
    # GPS
    try:
        gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
    except Exception:
        gps_ifd = None
    if gps_ifd:
        def dms(vals):
            d, m, s = [float(x) for x in vals]
            return d + m / 60 + s / 3600
        try:
            lat = dms(gps_ifd[_GPS_TAGS["GPSLatitude"]])
            if gps_ifd.get(_GPS_TAGS["GPSLatitudeRef"], "N") in ("S", b"S"):
                lat = -lat
            lon = dms(gps_ifd[_GPS_TAGS["GPSLongitude"]])
            if gps_ifd.get(_GPS_TAGS["GPSLongitudeRef"], "E") in ("W", b"W"):
                lon = -lon
            latlon = (round(lat, 6), round(lon, 6))
        except (KeyError, TypeError, ValueError):
            pass
    return taken, latlon


def in_reserve(latlon):
    if not latlon:
        return None
    lat, lon = latlon
    return (RES_BBOX["lat_min"] <= lat <= RES_BBOX["lat_max"]
            and RES_BBOX["lon_min"] <= lon <= RES_BBOX["lon_max"])


def is_sensitive(subject_type, subject_id, sp_idx):
    if subject_type != "species":
        return False
    s = sp_idx.get(subject_id, {})
    if s.get("sensitive") is True:
        return True
    return s.get("family") in SENSITIVE_FALLBACK_FAMILIES


# ---------- procesamiento de una imagen ----------
def save_variants(img, out_dir, thumb_dir, stem):
    full = ImageOps.contain(img, (FULL_MAX, FULL_MAX))
    thumb = ImageOps.contain(img, (THUMB_MAX, THUMB_MAX))
    webp_path = out_dir / f"{stem}.webp"
    jpg_path = out_dir / f"{stem}.jpg"
    thumb_path = thumb_dir / f"{stem}.webp"
    if not DRY:
        out_dir.mkdir(parents=True, exist_ok=True)
        thumb_dir.mkdir(parents=True, exist_ok=True)
        full.save(webp_path, "WEBP", quality=WEBP_Q, method=6)
        full.convert("RGB").save(jpg_path, "JPEG", quality=JPG_Q, optimize=True)
        thumb.save(thumb_path, "WEBP", quality=THUMB_Q, method=6)
    return webp_path, jpg_path, thumb_path, full.size


def rel(path):
    return str(path.relative_to(PUBLIC)).replace("\\", "/")


def main():
    if not INCOMING.exists():
        print(f"⚠️  No existe {INCOMING}. Nada que procesar.")
        return

    sp_idx = species_index()
    wp_ids = waypoint_ids()
    tr_ids = trail_ids()
    rt_ids = route_ids()
    # ids válidos + archivo de referencia por tipo de sujeto
    VALID = {"species": (set(sp_idx), "species.json"), "waypoint": (wp_ids, "waypoints.geojson"),
             "trail": (tr_ids, "trails.geojson"), "route": (rt_ids, "routes.json")}
    media = load_json(MEDIA_JSON) if MEDIA_JSON.exists() else {"_meta": {}, "photos": []}
    photos = media.setdefault("photos", [])
    # conserva campos manuales por 'file'
    by_file = {p["file"]: p for p in photos}
    default_credit = media.get("_meta", {}).get("default_credit", "Reserva Natural Cantares")
    default_license = media.get("_meta", {}).get("default_license", "CC BY 4.0")

    def max_index(subject_type, subject_id):
        n = 0
        for p in photos:
            if p["subject_type"] == subject_type and p["subject_id"] == subject_id:
                try:
                    n = max(n, int(Path(p["file"]).stem.split("__")[-1]))
                except ValueError:
                    pass
        return n

    jobs = [("especies", "species", IMG / "species"),
            ("puntos", "waypoint", IMG / "waypoints"),
            ("senderos", "trail", IMG / "trails"),
            ("recorridos", "route", IMG / "routes")]

    processed = 0
    warnings = []
    heic_seen = []
    per_subject = {}

    for folder, subject_type, out_dir in jobs:
        base = INCOMING / folder
        if not base.exists():
            continue
        for subj_dir in sorted(p for p in base.iterdir() if p.is_dir()):
            subject_id = subj_dir.name
            # validación contra el archivo de referencia del tipo de sujeto
            valid_ids, ref_file = VALID[subject_type]
            if subject_id not in valid_ids:
                warnings.append(f"❓ id desconocido: {folder}/{subject_id}/ "
                                f"(no está en {ref_file}) — omitido")
                continue
            files = sorted(f for f in subj_dir.iterdir()
                           if f.is_file() and f.suffix.lower() in VALID_EXT | HEIC_EXT)
            n = max_index(subject_type, subject_id)
            for src in files:
                if src.suffix.lower() in HEIC_EXT:
                    heic_seen.append(str(src.relative_to(INCOMING)))
                    continue
                try:
                    img = Image.open(src)
                    img = ImageOps.exif_transpose(img)         # auto-orienta
                    taken, latlon = read_exif(Image.open(src))  # EXIF del original
                except Exception as e:
                    warnings.append(f"⚠️  no se pudo abrir {src.name}: {e}")
                    continue

                n += 1
                stem = f"{subject_id}__{n}"
                webp, jpg, thumb, (w, h) = save_variants(img, out_dir, THUMBS, stem)

                # aviso GPS fuera de reserva (solo especies)
                inside = in_reserve(latlon)
                if subject_type == "species" and inside is False:
                    warnings.append(f"📍 {stem}: GPS fuera de la reserva {latlon} — ¿especie mal clasificada?")

                sensitive = is_sensitive(subject_type, subject_id, sp_idx)
                rec = {
                    "file": rel(webp), "jpg": rel(jpg), "thumb": rel(thumb),
                    "subject_type": subject_type, "subject_id": subject_id,
                    "is_primary": False,
                    "credit": default_credit, "license": default_license,
                    "caption": "", "caption_en": "",
                    "taken": taken,
                    "w": w, "h": h,
                    "bytes": webp.stat().st_size if (not DRY and webp.exists()) else None,
                }
                # coordenadas: se omiten para sensibles o si están fuera/no hay
                if latlon and inside and not sensitive:
                    rec["lat"], rec["lon"] = latlon
                elif sensitive and latlon:
                    rec["dataGeneralizations"] = "Coordenadas retenidas (especie sensible)"

                # conserva campos manuales si el file ya existía
                if rec["file"] in by_file:
                    old = by_file[rec["file"]]
                    for k in ("is_primary", "credit", "license", "caption", "caption_en"):
                        rec[k] = old.get(k, rec[k])
                    photos[photos.index(old)] = rec
                else:
                    photos.append(rec)
                by_file[rec["file"]] = rec

                # respaldo del original
                if not DRY:
                    dest = ORIGINALS / folder / subject_id
                    dest.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(src), str(dest / src.name))

                processed += 1
                per_subject[f"{subject_type}:{subject_id}"] = per_subject.get(f"{subject_type}:{subject_id}", 0) + 1
                print(f"  ✓ {stem}  ({w}×{h}, {rec['bytes'] or '?'} B){' [sensible: sin GPS]' if sensitive else ''}")

    # asegura una imagen principal por sujeto
    subjects = {(p["subject_type"], p["subject_id"]) for p in photos}
    for st, sid in subjects:
        group = [p for p in photos if p["subject_type"] == st and p["subject_id"] == sid]
        if not any(p["is_primary"] for p in group):
            group[0]["is_primary"] = True

    if not DRY:
        with open(MEDIA_JSON, "w", encoding="utf-8") as f:
            json.dump(media, f, ensure_ascii=False, indent=2)

    # ---------- resumen ----------
    print("\n" + "=" * 56)
    print(f"{'DRY-RUN — ' if DRY else ''}Procesadas {processed} foto(s).")
    if per_subject:
        for k, v in sorted(per_subject.items()):
            print(f"   {k}: {v}")
    if heic_seen:
        print(f"\n⚠️  {len(heic_seen)} foto(s) HEIC omitidas (iPhone). Cambia el celular a "
              f"«Más compatible» (JPG) o instala pillow-heif:")
        for h in heic_seen[:8]:
            print(f"     {h}")
    if warnings:
        print("\nAvisos:")
        for w in warnings:
            print(f"   {w}")

    # cobertura del inventario
    have = {p["subject_id"] for p in photos if p["subject_type"] == "species"}
    missing = [sid for sid in sp_idx if sid not in have]
    print(f"\nCobertura especies: {len(have)}/{len(sp_idx)} con foto. "
          f"Faltan {len(missing)}.")
    flagged = sum(1 for p in photos if p.get("subject_type") == "species"
                  and is_sensitive("species", p["subject_id"], sp_idx))
    if flagged:
        print(f"({flagged} registro(s) de especies sensibles con coordenadas retenidas.)")


if __name__ == "__main__":
    main()
