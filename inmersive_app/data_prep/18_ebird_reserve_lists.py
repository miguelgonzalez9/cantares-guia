#!/usr/bin/env python3
"""
18_ebird_reserve_lists.py — Construye el inventario de AVES en dos capas:

  • VISTAS ("actually seen")     = censo de la reserva ∪ hotspot eBird de Cantares
                                   (L28187817). Aves realmente registradas en la reserva.
  • POTENCIALES ("could be seen") = unión de los hotspots del MISMO macizo montano
                                   (Cantares + complejo Río Blanco + Owl's Watch). Es el
                                   conjunto cerrado del motor de ID (BioCLIP): más amplio =
                                   puede reconocer un visitante raro aún no registrado aquí.

Cada ave queda con:
  reserve_status : "seen" | "potential"
  seen           : bool   (en censo o en el hotspot de Cantares)
  in_census      : bool
  in_ebird_hotspot: bool  (visto en el hotspot eBird de Cantares)
  potential      : bool   (en la unión montana → conjunto cerrado del ID)
  source         : census | ebird_hotspot | ebird_area  (procedencia de la fila)
  + family, order, common_name (es), common_name_en, ebird_common_es/en

IDEMPOTENTE: empareja por nombre científico normalizado. A las aves existentes solo
les añade/actualiza banderas y taxonomía (no toca id, photo, flagship, zones, notes).
NO toca flora/mamíferos/anfibios.

Uso:  python data_prep/18_ebird_reserve_lists.py [--dry-run]
Requiere EBIRD_API_KEY en .env.  Reserva ~ centroide de los waypoints.
"""

import json
import re
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "app" / "public" / "data"
SPECIES = DATA / "species.json"
ENV = Path(__file__).resolve().parent / ".env"

DRY = "--dry-run" in sys.argv

CANTARES_HOTSPOT = "L28187817"
# Unión montana (mismo macizo forestal Río Blanco–Cantares). Excluye paradas urbanas/bajas.
MONTANE_HOTSPOTS = [
    "L28187817",   # Cantares Reserva Natural
    "L1252500",    # Reserva Ecológica Río Blanco--Lodge
    "L7630492",    # Reserva Ecológica Río Blanco--Entrada
    "L11918683",   # Owl's Watch (contiguo a Cantares)
    "L19141373",   # Camino a Reserva Río Blanco
    "L41900483",   # Reserva Ecological Rio Blanco
    "L9208950",    # RN Río Blanco--Martinica Navarra
]


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
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return " ".join(s.split()).strip().lower()


def slug(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower() or "ave"


def get(path, key, params=""):
    url = f"https://api.ebird.org/v2/{path}" + (f"?{params}" if params else "")
    req = urllib.request.Request(url, headers={"X-eBirdApiToken": key})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def taxonomy(key):
    """norm(sci) → {sci, family, order, com_en, com_es}  y  code → sci."""
    tax, code2sci = {}, {}
    for loc, field in (("en", "com_en"), ("es", "com_es")):
        for r in get("ref/taxonomy/ebird", key, f"fmt=json&locale={loc}"):
            k = norm(r.get("sciName", ""))
            if not k:
                continue
            rec = tax.setdefault(k, {"sci": r["sciName"]})
            rec[field] = r.get("comName", "")
            rec.setdefault("family", r.get("familySciName", "") or "")
            rec.setdefault("order", r.get("order", "") or "")
            code2sci[r.get("speciesCode", "")] = r["sciName"]
        time.sleep(0.3)
    return tax, code2sci


def hotspot_species(locId, key, code2sci):
    return {norm(code2sci[c]) for c in get(f"product/spplist/{locId}", key) if code2sci.get(c)}


def main():
    key = load_env(ENV).get("EBIRD_API_KEY", "")
    if not key:
        print("Falta EBIRD_API_KEY en .env"); sys.exit(1)

    print("Bajando taxonomía eBird (en + es)…")
    tax, code2sci = taxonomy(key)

    print("Bajando hotspot de Cantares (vistas) + unión montana (potenciales)…")
    seen_ebird = hotspot_species(CANTARES_HOTSPOT, key, code2sci)
    potential = set()
    for loc in MONTANE_HOTSPOTS:
        potential |= hotspot_species(loc, key, code2sci)
        time.sleep(0.3)

    doc = json.loads(SPECIES.read_text(encoding="utf-8"))
    sp = doc["species"]
    birds = [s for s in sp if s.get("group") == "ave"]
    by_sci = {norm(s["scientific_name"]): s for s in birds}
    census_sci = set(by_sci)                      # lo que YA estaba = censo de la reserva
    used_ids = {s["id"] for s in sp}

    # universo de aves de species.json = censo ∪ vistas-hotspot ∪ potenciales-montana
    universe = census_sci | seen_ebird | potential

    def decorate(rec, k):
        """Aplica banderas + taxonomía a una fila-ave (existente o nueva)."""
        in_census = k in census_sci
        in_hot = k in seen_ebird
        is_seen = in_census or in_hot
        rec["in_census"] = in_census
        rec["in_ebird_hotspot"] = in_hot
        rec["seen"] = is_seen
        rec["potential"] = k in potential
        rec["reserve_status"] = "seen" if is_seen else "potential"
        t = tax.get(k)
        if t:
            if not rec.get("family"):
                rec["family"] = t.get("family", "")
            if not rec.get("order"):
                rec["order"] = t.get("order", "")
            if t.get("com_es"):
                rec.setdefault("ebird_common_es", t["com_es"])
            if t.get("com_en"):
                rec.setdefault("ebird_common_en", t["com_en"])
            sci = rec.get("scientific_name", "")
            if t.get("com_es") and (not rec.get("common_name") or rec["common_name"] == sci):
                rec["common_name"] = t["com_es"]
            if t.get("com_en") and (not rec.get("common_name_en") or rec["common_name_en"] == sci):
                rec["common_name_en"] = t["com_en"]

    n_new = 0
    for k in sorted(universe):
        rec = by_sci.get(k)
        if rec:                                   # ave existente → solo banderas + taxo
            decorate(rec, k)
            continue
        # ave NUEVA (vista-hotspot o potencial) → crear fila mínima desde eBird
        t = tax.get(k, {})
        sci = t.get("sci") or k.title()
        base = slug(t.get("com_es") or sci)
        sid, i = base, 1
        while sid in used_ids:
            i += 1; sid = f"{base}-{i}"
        used_ids.add(sid)
        source = "ebird_hotspot" if k in seen_ebird else "ebird_area"
        rec = {
            "id": sid, "group": "ave", "scientific_name": sci,
            "common_name": t.get("com_es") or sci, "common_name_en": t.get("com_en") or "",
            "family": t.get("family", ""), "order": t.get("order", ""),
            "flagship": False, "id_tool": "merlin", "zones": [], "photo": None,
            "notes": "", "source": source, "ebird": True,
            "ebird_common_es": t.get("com_es", ""), "ebird_common_en": t.get("com_en", ""),
        }
        decorate(rec, k)
        sp.append(rec)
        n_new += 1

    # ---- reporte ----
    birds2 = [s for s in sp if s.get("group") == "ave"]
    n_seen = sum(1 for s in birds2 if s["seen"])
    n_pot = sum(1 for s in birds2 if s["reserve_status"] == "potential")
    n_census = sum(1 for s in birds2 if s["in_census"])
    n_hot = sum(1 for s in birds2 if s["in_ebird_hotspot"])
    print("\n" + ("DRY-RUN — " if DRY else "") + "Inventario de aves (dos capas)")
    print(f"  Total aves ahora: {len(birds2)}   (antes: {len(birds)}, nuevas: {n_new})")
    print(f"  VISTAS (seen):        {n_seen}   [censo {n_census} · hotspot eBird {n_hot}]")
    print(f"  POTENCIALES (solo):   {n_pot}   (en la unión montana, aún no vistas aquí)")
    print(f"  Conjunto cerrado ID (potential=true): {sum(1 for s in birds2 if s['potential'])}")

    if not DRY:
        SPECIES.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  Escrito → {SPECIES.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
