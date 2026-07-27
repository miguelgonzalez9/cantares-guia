#!/usr/bin/env python3
"""
20_sort_catalog.py — Materializa el catálogo (19_classify_archive) en un árbol de
carpetas por categoría, para navegar el archivo por tema. Los ORIGINALES en
`Fotos por fechas` / `fotos por temas` se PRESERVAN salvo en modo --move.

Destino: <archivo>/_clasificado/<categoria>/[<especie>/]<nombre-original>
Solo las clasificadas (excluye _sin_clasificar).

Modos (mutuamente excluyentes):
  --link  (default)  enlace duro (hard link): 0 espacio local, original intacto.
                     OJO: Dropbox puede subir cada enlace como copia (≈22 GB).
  --copy             copia real: +22 GB en disco y en Dropbox. Original intacto.
  --move             mueve: 0 espacio extra, PERO reorganiza (pierde el orden por
                     fecha/tema del original). Reversible con el catálogo (guarda ruta).

Por defecto DRY-RUN (no toca nada). Añade --go para ejecutar. Idempotente.

Uso:
  python data_prep/20_sort_catalog.py                 # dry-run, plan + tamaño
  python data_prep/20_sort_catalog.py --link --go     # ejecuta con enlaces duros
  python data_prep/20_sort_catalog.py --move --go
"""
import json
import os
import re
import shutil
import sys
import unicodedata
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
CAT = HERE / "_archive_work" / "catalog_fotos-reserva-cantares.json"


def slug(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower() or "sp"


def main():
    args = sys.argv
    go = "--go" in args
    mode = "move" if "--move" in args else "copy" if "--copy" in args else "link"
    d = json.loads(CAT.read_text(encoding="utf-8"))
    base = Path(d["base"])
    out_root = base / "_clasificado"

    items = [r for r in d["items"] if r["category"] != "_sin_clasificar"]
    by_cat = Counter(r["category"] for r in items)
    tot_bytes = 0
    plan = []
    for r in items:
        src = base / r["file"]
        sub = slug(r["scientific_name"]) if r.get("scientific_name") else ""
        dest = out_root / r["category"] / sub / src.name
        plan.append((src, dest))
        if mode == "copy":
            try:
                tot_bytes += src.stat().st_size
            except OSError:
                pass

    print(f"{'DRY-RUN — ' if not go else ''}Materializar catálogo → {out_root}")
    print(f"  modo: {mode}   | archivos a organizar: {len(items)}")
    for c, n in by_cat.most_common():
        print(f"    {c:16} {n}")
    if mode == "copy":
        print(f"  espacio adicional (copia): {tot_bytes/1e9:.2f} GB")
    elif mode == "link":
        print("  espacio local adicional: ~0 (enlaces duros). Dropbox podría subir copias.")
    else:
        print("  espacio extra: 0 (mueve; reorganiza los originales — reversible vía catálogo).")
    if not go:
        print("\n  (dry-run: nada tocado. Añade --go para ejecutar.)")
        return

    n_ok = n_skip = n_err = 0
    for src, dest in plan:
        if not src.exists():
            n_err += 1
            continue
        if dest.exists():
            n_skip += 1
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            if mode == "link":
                os.link(src, dest)          # enlace duro (mismo volumen)
            elif mode == "copy":
                shutil.copy2(src, dest)
            else:
                shutil.move(str(src), str(dest))
            n_ok += 1
        except Exception as e:
            print(f"  ! {src.name}: {type(e).__name__}: {e}")
            n_err += 1
    print(f"\nListo ({mode}): {n_ok} organizadas, {n_skip} ya existían, {n_err} errores.")
    print(f"  → {out_root}")


if __name__ == "__main__":
    main()
