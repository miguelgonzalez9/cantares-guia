#!/usr/bin/env python3
"""
audit_catalog.py — Muestrea el catálogo generado por 19_classify_archive.py para
AUDITAR visualmente (control de calidad de falsos positivos sobre el bulk real, no
solo el ground-truth). Imprime rutas absolutas por categoría (para revisar con ojo)
y un resumen. Determinista (sin azar): toma las primeras/espaciadas por categoría.

Uso:
  python data_prep/audit_catalog.py                      # resumen + 4 muestras/categoría
  python data_prep/audit_catalog.py --per 8              # 8 muestras por categoría
  python data_prep/audit_catalog.py --cat aguas          # solo una categoría
  python data_prep/audit_catalog.py --catalog <ruta.json>
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT = HERE / "_archive_work" / "catalog_fotos-reserva-cantares.json"


def main():
    args = sys.argv
    cat_path = Path(args[args.index("--catalog") + 1]) if "--catalog" in args else DEFAULT
    per = int(args[args.index("--per") + 1]) if "--per" in args else 4
    only = args[args.index("--cat") + 1] if "--cat" in args else None
    d = json.loads(cat_path.read_text(encoding="utf-8"))
    base = Path(d["base"])
    items = d["items"]

    by_cat = defaultdict(list)
    for r in items:
        by_cat[r["category"]].append(r)

    print(f"Catálogo: {cat_path.name}  ({len(items)} archivos)  base={base}")
    print("Resumen por categoría (con confianza media):")
    for cat in sorted(by_cat, key=lambda c: -len(by_cat[c])):
        rs = by_cat[cat]
        avg = sum(r["confidence"] for r in rs) / len(rs)
        sp = sum(1 for r in rs if r.get("scientific_name"))
        print(f"  {cat:16} {len(rs):>5}  conf~{avg:.2f}" + (f"  (especie: {sp})" if sp else ""))

    print("\nMuestras para auditar (rutas absolutas — revisar con visor/Read):")
    for cat in sorted(by_cat):
        if only and cat != only:
            continue
        rs = by_cat[cat]
        # muestreo espaciado y determinista, priorizando confianza cercana al umbral
        step = max(1, len(rs) // per)
        sample = rs[::step][:per]
        print(f"\n[{cat}]  ({len(rs)} total)")
        for r in sample:
            sp = f"  sp={r['scientific_name']}" if r.get("scientific_name") else ""
            print(f"  conf={r['confidence']:.2f} {r['kind']:5} {base / r['file']}{sp}")


if __name__ == "__main__":
    main()
