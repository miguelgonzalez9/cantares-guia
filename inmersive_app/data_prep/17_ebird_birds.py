#!/usr/bin/env python3
"""
17_ebird_birds.py — Aves desde eBird: enriquece el inventario y lista la zona.

eBird NO identifica fotos (eso lo hace BioCLIP cerrado en 14). Aquí eBird aporta:
  (1) TAXONOMÍA OFICIAL para las aves que YA están en species.json — familia, orden,
      nombre común es/en. Empareja por nombre científico contra la taxonomía global
      de eBird → casi 100% de match (los nombres del censo son especies reales).
  (2) LISTA DE LA ZONA — especies reportadas cerca de la reserva (radio geo +
      hotspots más cercanos), escrita a  info/censos_inventarios/ebird_cantares.json
      para que la revises. Marca cuáles de esas YA están en el inventario.

Por defecto SOLO enriquece (seguro: no añade especies). El inventario del juego es
la reserva (83 aves del censo), NO las ~250 que eBird reporta en 10 km. Añadir esas
como "posibles" está detrás de  --augment  (las mete con status='ebird_nearby' y
flagship=False; tú decides luego cuáles ascender).

Uso:
  python data_prep/17_ebird_birds.py               # enriquece species.json + escribe ebird_cantares.json
  python data_prep/17_ebird_birds.py --dry-run     # no escribe nada, solo reporta
  python data_prep/17_ebird_birds.py --augment     # además añade las aves cercanas (flag ebird_nearby)
  python data_prep/17_ebird_birds.py --dist 5      # radio geo en km (default 10)

Requiere: EBIRD_API_KEY en .env  (gratis, no expira: https://ebird.org/api/keygen)
Reserva ~ lat 5.082, lon -75.451 (centroide de los waypoints).
"""

import json
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "app" / "public" / "data"
SPECIES = DATA / "species.json"
WAYPOINTS = DATA / "waypoints.geojson"
ENV = Path(__file__).resolve().parent / ".env"
OUT = ROOT.parent / "info" / "censos_inventarios" / "ebird_cantares.json"

DRY = "--dry-run" in sys.argv
AUGMENT = "--augment" in sys.argv
DIST_KM = 10
if "--dist" in sys.argv:
    DIST_KM = int(sys.argv[sys.argv.index("--dist") + 1])

HOTSPOT_RADIUS_KM = 15      # buscar hotspots en este radio; tomar los N más ricos
TOP_HOTSPOTS = 3            # cuántos hotspots cercanos sumar a la lista de la zona
API = "https://api.ebird.org/v2"


# ---------- utilidades ----------
def load_env(p):
    env = {}
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def norm(s):
    """clave de match: minúsculas, sin acentos, espacios colapsados."""
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return " ".join(s.split()).strip().lower()


def get(path, key, params=None):
    url = f"{API}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"X-eBirdApiToken": key})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def reserve_center():
    fc = json.loads(WAYPOINTS.read_text(encoding="utf-8"))
    pts = [f["geometry"]["coordinates"] for f in fc.get("features", [])
           if f.get("geometry", {}).get("type") == "Point"]
    if not pts:
        return 5.08194, -75.45085
    return sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts)


# ---------- eBird ----------
def fetch_taxonomy(key):
    """Devuelve (tax, code2sci).
    tax: norm(sciName) → {sci, family_sci, family_com, order, com_en, com_es}.
    code2sci: speciesCode eBird → sciName (para resolver spplist de hotspots).
    Dos llamadas (en, es) a la taxonomía completa; se cachea entera en memoria."""
    tax, code2sci = {}, {}
    for locale, field in (("en", "com_en"), ("es", "com_es")):
        rows = get("ref/taxonomy/ebird", key, {"fmt": "json", "locale": locale})
        for r in rows:
            k = norm(r.get("sciName", ""))
            if not k:
                continue
            rec = tax.setdefault(k, {"sci": r.get("sciName", "")})
            rec[field] = r.get("comName", "")
            rec.setdefault("family_sci", r.get("familySciName", "") or "")
            rec.setdefault("family_com", r.get("familyComName", "") or "")
            rec.setdefault("order", r.get("order", "") or "")
            code2sci[r.get("speciesCode", "")] = r.get("sciName", "")
        time.sleep(0.3)
    return tax, code2sci


def fetch_nearby(key, lat, lon):
    """Lista de la zona: especies de obs recientes (radio geo) ∪ hotspots cercanos.
    Devuelve dict norm(sci) → {sci, sources:set}. Los códigos de hotspot se resuelven
    a sci vía la taxonomía en el llamador."""
    zone = {}   # norm(sci) -> {"sci":..., "sources":set()}

    def add(sci, src):
        if not sci:
            return
        z = zone.setdefault(norm(sci), {"sci": sci, "sources": set()})
        z["sources"].add(src)

    # (a) observaciones recientes en radio geo (últimos ~30 días)
    obs = get("data/obs/geo/recent", key,
              {"lat": round(lat, 5), "lng": round(lon, 5), "dist": DIST_KM, "fmt": "json"})
    for o in obs:
        add(o.get("sciName", ""), f"geo{DIST_KM}km")

    # (b) hotspots más ricos dentro de HOTSPOT_RADIUS_KM → su checklist histórico
    hs = get("ref/hotspot/geo", key,
             {"lat": round(lat, 5), "lng": round(lon, 5), "dist": HOTSPOT_RADIUS_KM, "fmt": "json"})
    hs = sorted(hs, key=lambda h: h.get("numSpeciesAllTime", 0), reverse=True)[:TOP_HOTSPOTS]
    for h in hs:
        codes = get(f"product/spplist/{h['locId']}", key)
        for c in codes:
            add(f"__CODE__{c}", h["locName"])   # marcador; se resuelve luego vía code2sci
        time.sleep(0.3)
    return zone, [h["locId"] for h in hs], [h["locName"] for h in hs]


# ---------- principal ----------
def main():
    key = load_env(ENV).get("EBIRD_API_KEY", "")
    if not key:
        print("Falta EBIRD_API_KEY en .env  (https://ebird.org/api/keygen)")
        sys.exit(1)

    doc = json.loads(SPECIES.read_text(encoding="utf-8"))
    sp = doc["species"]
    birds = [s for s in sp if s.get("group") == "ave"]
    by_sci = {norm(s.get("scientific_name", "")): s for s in birds}
    used_ids = {s["id"] for s in sp}

    lat, lon = reserve_center()
    print(f"Reserva ~ lat {lat:.5f}, lon {lon:.5f}   | aves en inventario: {len(birds)}")
    print("Bajando taxonomía de eBird (en + es)…")
    tax, code2sci = fetch_taxonomy(key)

    # ---- (1) ENRIQUECER las aves existentes ----
    n_enriched = n_nomatch = 0
    nomatch = []
    for b in birds:
        t = tax.get(norm(b.get("scientific_name", "")))
        if not t:
            n_nomatch += 1
            nomatch.append(b.get("scientific_name", ""))
            continue
        changed = False
        if not b.get("family") and t.get("family_sci"):
            b["family"] = t["family_sci"]; changed = True
        for src, dst in (("order", "order"), ("family_com", "family_common")):
            if t.get(src) and not b.get(dst):
                b[dst] = t[src]; changed = True
        # nombres oficiales eBird (se guardan aparte por referencia)
        if t.get("com_es"):
            b.setdefault("ebird_common_es", t["com_es"])
        if t.get("com_en"):
            b.setdefault("ebird_common_en", t["com_en"])
        # fallback de nombre común: si el censo no tiene común (vacío o == científico),
        # usa el oficial de eBird para que la tarjeta no muestre latín. El app lee
        # common_name/common_name_en directo → sin lógica extra en el front.
        sci = b.get("scientific_name", "")
        if t.get("com_es") and (not b.get("common_name") or b["common_name"] == sci):
            b["common_name"] = t["com_es"]; changed = True
        if t.get("com_en") and (not b.get("common_name_en") or b["common_name_en"] == sci):
            b["common_name_en"] = t["com_en"]; changed = True
        b["ebird"] = True
        n_enriched += 1

    # ---- (2) LISTA DE LA ZONA ----
    print(f"Listando aves de la zona (geo {DIST_KM} km + {TOP_HOTSPOTS} hotspots)…")
    zone, hs_ids, hs_names = fetch_nearby(key, lat, lon)
    # resolver los marcadores __CODE__ a sci vía code2sci (de la taxonomía ya bajada)
    resolved = {}   # norm(sci) -> {"sci","sources"}
    for z in zone.values():
        real_sci = z["sci"]
        srcs = set(z["sources"])
        if real_sci.startswith("__CODE__"):
            real_sci = code2sci.get(real_sci[len("__CODE__"):], "")
            if not real_sci:
                continue
        r = resolved.setdefault(norm(real_sci), {"sci": real_sci, "sources": set()})
        r["sources"] |= srcs
    # decorar cada ave de la zona con taxonomía + si ya está en el inventario
    zone_list = []
    for k, z in sorted(resolved.items(), key=lambda kv: kv[1]["sci"]):
        t = tax.get(k, {})
        zone_list.append({
            "scientific_name": z["sci"],
            "common_en": t.get("com_en", ""),
            "common_es": t.get("com_es", ""),
            "family": t.get("family_sci", ""),
            "order": t.get("order", ""),
            "in_inventory": k in by_sci,
            "sources": sorted(z["sources"]),
        })
    in_inv = sum(1 for z in zone_list if z["in_inventory"])

    # ---- (opcional) AUGMENT: añadir aves de la zona que faltan ----
    n_added = 0
    if AUGMENT:
        for z in zone_list:
            if z["in_inventory"]:
                continue
            base = _slug(z["common_es"] or z["scientific_name"])
            sid, i = base, 1
            while sid in used_ids:
                i += 1; sid = f"{base}-{i}"
            used_ids.add(sid)
            sp.append({
                "id": sid, "group": "ave", "status": "ebird_nearby",
                "scientific_name": z["scientific_name"],
                "common_name": z["common_es"] or z["scientific_name"],
                "family": z["family"], "order": z["order"],
                "flagship": False, "id_tool": "merlin", "zones": [], "photo": None,
                "notes": "Reportada por eBird cerca de la reserva; sin confirmar en el censo.",
                "source": "ebird_nearby", "ebird": True,
                "ebird_common_en": z["common_en"], "ebird_common_es": z["common_es"],
            })
            n_added += 1

    # ---- escribir ----
    if not DRY:
        SPECIES.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps({
            "generated_for": {"lat": lat, "lon": lon, "dist_km": DIST_KM},
            "hotspots": [{"id": i, "name": n} for i, n in zip(hs_ids, hs_names)],
            "n_species": len(zone_list), "n_in_inventory": in_inv,
            "species": zone_list,
        }, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- reporte ----
    print("\n" + ("DRY-RUN — " if DRY else "") + "eBird → inventario de aves")
    print(f"  (1) Enriquecidas (familia/orden/nombres): {n_enriched}/{len(birds)}")
    if n_nomatch:
        print(f"      sin match en taxonomía eBird ({n_nomatch}): {', '.join(nomatch[:8])}"
              + (" …" if n_nomatch > 8 else ""))
    print(f"  (2) Aves en la zona (≤{DIST_KM}km + hotspots): {len(zone_list)}"
          f"  | ya en inventario: {in_inv}  | nuevas: {len(zone_list) - in_inv}")
    if AUGMENT:
        print(f"      AUGMENT: añadidas como 'ebird_nearby': {n_added}")
    else:
        print("      (usa --augment para añadir las nuevas como 'ebird_nearby')")
    if not DRY:
        print(f"  Lista de la zona → {OUT.relative_to(ROOT.parent)}")
    print(f"  Hotspots usados: {', '.join(hs_names)}")


def _slug(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    import re
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower() or "ave"


if __name__ == "__main__":
    main()
