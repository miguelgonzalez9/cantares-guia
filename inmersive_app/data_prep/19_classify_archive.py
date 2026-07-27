#!/usr/bin/env python3
"""
19_classify_archive.py — Cataloga (NO destructivo) fotos Y videos con el clasificador
local (CLIP categoría + BioCLIP especie), aplicando la config anti-falso-positivo de
id_local.decide_category / decide_video (calibrada con eval_classifier.py).

  • NO mueve archivos: escribe un catálogo (archivo → categoría/confianza/especie/razón),
    preservando la organización por fechas/temas de Miguel. Mover/copiar = paso posterior.
  • EXCLUYE carpetas curadas a mano: nuestra_historia, eco_turismo (en cualquier nivel).
  • Constraint #1: ante la duda → _sin_clasificar (umbral+margen; video por consenso de frames).
  • Resumible: salta lo ya catalogado (por ruta+mtime). Guarda cada N.

Uso:
  python data_prep/19_classify_archive.py                 # archivo por defecto (Reserva.../fotos Reserva Cantares)
  python data_prep/19_classify_archive.py --dir "<ruta>"  # otra carpeta (p.ej. Cantares/fotos)
  python data_prep/19_classify_archive.py --limit 50       # prueba
  python data_prep/19_classify_archive.py --no-species     # solo categoría (más rápido)
"""

import json
import sys
import time
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import id_local

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
CANTARES = ROOT.parent
DEFAULT_DIR = CANTARES / "Reserva natural cantares" / "fotos Reserva Cantares"
SPECIES_JSON = ROOT / "app" / "public" / "data" / "species.json"

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
VID_EXT = {".mp4", ".mov", ".m4v", ".avi"}
EXCLUDE_DIRS = {"nuestra_historia", "eco_turismo"}   # curadas a mano → no auto

# Umbrales BioCLIP (especie) — igual que 14_classify_photos.
SPECIES_MIN = 0.30
SPECIES_MARGIN = 0.08
# CLIP categoría → grupo del inventario (para el guardia de acuerdo CLIP↔BioCLIP)
CAT_GROUP = {"ave": "ave", "mamifero": "mamifero", "anfibio": "anfibio",
             "flor": "flora", "planta": "flora", "arbol": "flora"}


def load_closed_set():
    """Nombres científicos del inventario + mapa norm(sci)→registro (para especie)."""
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


def excluded(path, base):
    parts = {p.lower() for p in path.relative_to(base).parts}
    return bool(parts & EXCLUDE_DIRS)


def species_for(path, category, names, by_sci):
    """Si CLIP dice organismo, intenta especie con BioCLIP (cerrado al inventario).
    Devuelve (scientific_name|None, score, razón). Guardia: CLIP y BioCLIP concuerdan grupo."""
    want_group = CAT_GROUP.get(category)
    if not want_group:
        return None, 0.0, "categoría no-organismo"
    try:
        preds = id_local.identify_species(path, names)
    except Exception as e:
        return None, 0.0, f"BioCLIP falló ({type(e).__name__})"
    if not preds:
        return None, 0.0, "sin predicción"
    top_sci, top_sc = preds[0]
    second = preds[1][1] if len(preds) > 1 else 0.0
    rec = by_sci.get(top_sci.lower())
    if rec and rec.get("group") == want_group and top_sc >= SPECIES_MIN and (top_sc - second) >= SPECIES_MARGIN:
        return rec.get("scientific_name"), top_sc, "especie confirmada"
    return None, top_sc, "especie incierta"


def main():
    args = sys.argv
    base = Path(args[args.index("--dir") + 1]) if "--dir" in args else DEFAULT_DIR
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    max_seconds = float(args[args.index("--max-seconds") + 1]) if "--max-seconds" in args else None
    do_species = "--no-species" not in args
    base = base.resolve()

    slug = unicodedata.normalize("NFKD", base.name).encode("ascii", "ignore").decode()
    slug = "".join(ch if ch.isalnum() else "-" for ch in slug).strip("-").lower() or "dir"
    out_path = Path(__file__).resolve().parent / "_archive_work" / f"catalog_{slug}.json"
    out_path.parent.mkdir(exist_ok=True)

    catalog = {}
    if out_path.exists():
        for r in json.loads(out_path.read_text(encoding="utf-8")).get("items", []):
            catalog[r["key"]] = r

    names, by_sci = ([], {})
    if do_species:
        names, by_sci = load_closed_set()

    files = [p for p in base.rglob("*")
             if p.is_file() and p.suffix.lower() in (IMG_EXT | VID_EXT) and not excluded(p, base)]
    files.sort()
    if limit:
        files = files[:limit]
    print(f"Carpeta: {base}")
    print(f"Archivos media (excl. {', '.join(EXCLUDE_DIRS)}): {len(files)}  | especie: {'sí' if do_species else 'no'}")
    print(f"Catálogo: {out_path.name}  (ya catalogados: {len(catalog)})")

    n_done = n_img = n_vid = n_class = n_abst = n_fail = 0
    t0 = time.time()
    for i, p in enumerate(files):
        try:
            key = f"{p.relative_to(base)}::{int(p.stat().st_mtime)}"
        except OSError:
            continue
        if key in catalog:
            continue
        if max_seconds and (time.time() - t0) > max_seconds:   # corte por tiempo (control en primer plano)
            print(f"  corte por --max-seconds ({max_seconds}s); {n_done} nuevos esta tanda.")
            break
        is_vid = p.suffix.lower() in VID_EXT
        rec = {"key": key, "file": str(p.relative_to(base)).replace("\\", "/"),
               "kind": "video" if is_vid else "photo",
               "category": "_sin_clasificar", "confidence": 0.0,
               "scientific_name": None, "reason": ""}
        try:
            if is_vid:
                fs = id_local.video_category_scores(p, n=3)
                cat, reason = id_local.decide_video(fs)
                conf = max((s[0][1] for s in fs), default=0.0)
                n_vid += 1
            else:
                scores = id_local.category_scores(p)
                cat, reason = id_local.decide_category(scores)
                conf = scores[0][1]
                n_img += 1
            rec["confidence"] = round(float(conf), 3)
            rec["reason"] = reason
            if cat:
                rec["category"] = cat
                if do_species and not is_vid and cat in id_local.ORGANISM_CATS:
                    sci, ssc, sreason = species_for(p, cat, names, by_sci)
                    if sci:
                        rec["scientific_name"] = sci
                        rec["reason"] += f" | {sreason} ({ssc:.2f})"
                n_class += 1
            else:
                n_abst += 1
        except Exception as e:
            rec["reason"] = f"error: {type(e).__name__}: {e}"
            n_fail += 1
        catalog[key] = rec
        n_done += 1
        if n_done % 25 == 0:
            _save(out_path, base, catalog)
            rate = n_done / (time.time() - t0)
            print(f"  {n_done} nuevos ({n_class} clasif, {n_abst} sin_clasif, {n_fail} err) "
                  f"· {rate:.1f}/s · ETA {(len(files)-i)/max(rate,0.01)/60:.0f}min")

    _save(out_path, base, catalog)
    print(f"\nListo. Total en catálogo: {len(catalog)}  (nuevos: {n_done}; img {n_img}, vid {n_vid})")
    _summary(catalog)


def _save(out_path, base, catalog):
    out_path.write_text(json.dumps(
        {"base": str(base), "n": len(catalog), "items": list(catalog.values())},
        ensure_ascii=False, indent=1), encoding="utf-8")


def _summary(catalog):
    from collections import Counter
    c = Counter(r["category"] for r in catalog.values())
    tot = len(catalog)
    classified = sum(v for k, v in c.items() if k != "_sin_clasificar")
    print("Resumen por categoría:")
    for k, v in c.most_common():
        print(f"  {k:18} {v:>5}  ({v/tot*100:.1f}%)")
    print(f"  → clasificados: {classified}/{tot} ({classified/tot*100:.1f}%)  | "
          f"_sin_clasificar: {c.get('_sin_clasificar',0)} ({c.get('_sin_clasificar',0)/tot*100:.1f}%)")
    with_sp = sum(1 for r in catalog.values() if r.get("scientific_name"))
    print(f"  → con especie confirmada: {with_sp}")


if __name__ == "__main__":
    main()
