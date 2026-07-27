#!/usr/bin/env python3
"""
reclassify_subset.py — Re-decide (con la config ACTUAL de id_local) solo las entradas
del catálogo que están en ciertas categorías. Se usa tras ajustar umbrales/añadir
categorías (p.ej. 'reptil') para NO re-encodear las 3.936: solo el subconjunto afectado.

Uso:
  python data_prep/reclassify_subset.py                       # re-decide fauna pequeña
  python data_prep/reclassify_subset.py --cats anfibio,mamifero,aracnido,insecto,hongo
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import id_local

HERE = Path(__file__).resolve().parent
CAT = HERE / "_archive_work" / "catalog_fotos-reserva-cantares.json"
VID_EXT = {".mp4", ".mov", ".m4v", ".avi"}

DEFAULT_CATS = {"anfibio", "mamifero", "aracnido", "insecto", "hongo"}


def main():
    args = sys.argv
    cats = set(args[args.index("--cats") + 1].split(",")) if "--cats" in args else DEFAULT_CATS
    d = json.loads(CAT.read_text(encoding="utf-8"))
    base = Path(d["base"])
    targets = [r for r in d["items"] if r["category"] in cats]
    print(f"Re-decidiendo {len(targets)} entradas en categorías {sorted(cats)} con la config actual…")

    changed = {}
    t0 = time.time()
    for i, r in enumerate(targets):
        p = base / r["file"]
        if not p.exists():
            continue
        try:
            if p.suffix.lower() in VID_EXT:
                fs = id_local.video_category_scores(p, n=3)
                cat, reason = id_local.decide_video(fs)
                conf = max((s[0][1] for s in fs), default=0.0)
            else:
                scores = id_local.category_scores(p)
                cat, reason = id_local.decide_category(scores)
                conf = scores[0][1]
        except Exception as e:
            cat, reason, conf = None, f"error {type(e).__name__}", 0.0
        newcat = cat or "_sin_clasificar"
        if newcat != r["category"]:
            changed.setdefault((r["category"], newcat), 0)
            changed[(r["category"], newcat)] += 1
        r["category"] = newcat
        r["confidence"] = round(float(conf), 3)
        r["reason"] = reason
        r["scientific_name"] = None
        if (i + 1) % 25 == 0:
            print(f"  {i+1}/{len(targets)}  ({(time.time()-t0):.0f}s)")

    CAT.write_text(json.dumps({"base": str(base), "n": len(d["items"]), "items": d["items"]},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print("\nCambios (antes → después):")
    for (a, b), n in sorted(changed.items(), key=lambda x: -x[1]):
        print(f"  {a:12} → {b:16} {n}")
    if not changed:
        print("  (ninguno)")


if __name__ == "__main__":
    main()
