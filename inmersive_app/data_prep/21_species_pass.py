#!/usr/bin/env python3
"""
21_species_pass.py — Segunda pasada: pone NOMBRE DE ESPECIE (BioCLIP, cerrado al
inventario de la reserva) a las entradas del catálogo que ya son ORGANISMO. No re-
clasifica categoría; solo intenta especie con el guardia de acuerdo CLIP↔BioCLIP.

Resumible: marca cada entrada procesada con `species_checked=True`; re-correr salta
las hechas. Guarda cada 25. Una sola corrida (BioCLIP tarda ~3min en cargar 730
etiquetas; batchear la reinicia cada vez → mejor un proceso largo, resumible).

Uso:
  python data_prep/21_species_pass.py
  python data_prep/21_species_pass.py --limit 100
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import id_local

HERE = Path(__file__).resolve().parent
CAT = HERE / "_archive_work" / "catalog_fotos-reserva-cantares.json"
SPECIES_JSON = HERE.parent / "app" / "public" / "data" / "species.json"

SPECIES_MIN, SPECIES_MARGIN = 0.30, 0.08
# categoría del catálogo (etiqueta CLIP) → grupo del inventario
CAT_GROUP = {"ave": "ave", "mamifero": "mamifero", "anfibio": "anfibio",
             "flor": "flora", "planta": "flora", "arbol": "flora"}


def load_closed_set():
    doc = json.loads(SPECIES_JSON.read_text(encoding="utf-8"))
    names, by_sci = [], {}
    for s in doc.get("species", []):
        if s.get("group") not in ("flora", "ave", "mamifero", "anfibio"):
            continue
        k = (s.get("scientific_name") or "").strip()
        if k and k.lower() not in by_sci:
            by_sci[k.lower()] = s
            names.append(k)
    return names, by_sci


def main():
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    d = json.loads(CAT.read_text(encoding="utf-8"))
    base = Path(d["base"])
    names, by_sci = load_closed_set()

    todo = [r for r in d["items"]
            if r["category"] in CAT_GROUP and r["kind"] == "photo"
            and not r.get("species_checked")]
    if limit:
        todo = todo[:limit]
    print(f"Especie (BioCLIP, {len(names)} del inventario) sobre {len(todo)} organismos sin revisar…")

    n_named = n_done = 0
    t0 = time.time()
    for r in todo:
        p = base / r["file"]
        want = CAT_GROUP[r["category"]]
        sci = None
        try:
            preds = id_local.identify_species(p, names)
            if preds:
                top_sci, top_sc = preds[0]
                second = preds[1][1] if len(preds) > 1 else 0.0
                rec = by_sci.get(top_sci.lower())
                if rec and rec.get("group") == want and top_sc >= SPECIES_MIN and (top_sc - second) >= SPECIES_MARGIN:
                    sci = rec.get("scientific_name")
        except Exception as e:
            r["reason"] = (r.get("reason", "") + f" | especie: error {type(e).__name__}").strip(" |")
        r["species_checked"] = True
        if sci:
            r["scientific_name"] = sci
            n_named += 1
        n_done += 1
        if n_done % 25 == 0:
            CAT.write_text(json.dumps({"base": str(base), "n": len(d["items"]), "items": d["items"]},
                                      ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"  {n_done}/{len(todo)}  (con especie: {n_named})  {(time.time()-t0):.0f}s")

    CAT.write_text(json.dumps({"base": str(base), "n": len(d["items"]), "items": d["items"]},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nListo. Revisadas {n_done}, con especie confirmada: {n_named}.")


if __name__ == "__main__":
    main()
