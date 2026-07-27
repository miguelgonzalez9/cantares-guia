#!/usr/bin/env python3
"""
eval_classifier.py — Mide precisión / falsos-positivos del clasificador CLIP sobre
ground-truth humano (carpetas ya organizadas por Miguel), para calibrar umbrales y
prompts con FP mínimos (constraint #1).

Ground truth = (carpeta → categoría canónica esperada). Dos fuentes:
  • Archivo `fotos por temas/`  (Paisajes, Flora, Familiares/Trabajadores→visitante, …)
  • `fotos/<categoría>/`         (aves, mamiferos, anfibios, insectos, … ya clasificadas)

Método: encodea cada imagen UNA vez (cache npz), luego evalúa cualquier prompt-set +
umbral al instante. Reporta, por categoría: correctos / falsos-positivos / abstenidos,
y la FRONTERA precisión-recall barriendo el umbral global.

Correcto  = canon(predicho) == esperado  y  confianza ≥ umbral.
FP        = confianza ≥ umbral pero canon(predicho) ≠ esperado.   ← minimizar esto.
Abstención= confianza < umbral → _sin_clasificar (seguro; no cuenta como FP).

Uso:
  python data_prep/eval_classifier.py            # baseline con CATEGORY_PROMPTS actuales
  python data_prep/eval_classifier.py --cap 60   # tope de imágenes por fuente (rápido)
  python data_prep/eval_classifier.py --sweep     # barrido de umbral (frontera P/R)
"""

import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import id_local

ROOT = Path(__file__).resolve().parents[1]           # inmersive_app/
CANTARES = ROOT.parent                               # Cantares/
ARCHIVE = CANTARES / "Reserva natural cantares" / "fotos Reserva Cantares"
FOTOS = CANTARES / "fotos"
WORK = Path(__file__).resolve().parent / "_archive_work"
CACHE = WORK / "emb_cache.npz"

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

# (carpeta, categoría_canónica_esperada, recursivo)
GT_SOURCES = [
    (ARCHIVE / "fotos por temas" / "Paisajes",                     "paisaje",         True),
    (ARCHIVE / "fotos por temas" / "Vista Manizales",              "paisaje",         True),
    (ARCHIVE / "fotos por temas" / "fotos dron enero 2025",        "paisaje",         True),
    (ARCHIVE / "fotos por temas" / "Drone",                        "paisaje",         True),
    (ARCHIVE / "fotos por temas" / "Familiares",                   "visitante",       True),
    (ARCHIVE / "fotos por temas" / "Trabajadores",                 "visitante",       True),
    (ARCHIVE / "fotos por temas" / "Flora",                        "flora",           True),
    # 'Siembra arboles y repoblacion' (restauracion) se OMITE: etiqueta de actividad
    # multi-label (gente + paisaje + arbolitos), no separable visualmente → se cura a mano.
    (ARCHIVE / "fotos por temas" / "Entrada a la Reserva",         "infraestructura", True),
    (ARCHIVE / "fotos por temas" / "Hongos",                       "hongo",           True),
    (FOTOS / "aves",        "ave",       True),
    (FOTOS / "mamiferos",   "mamifero",  True),
    (FOTOS / "anfibios",    "anfibio",   True),
    (FOTOS / "insectos",    "insecto",   True),
    (FOTOS / "aracnidos",   "aracnido",  True),
    (FOTOS / "flores",      "flora",     True),
    (FOTOS / "paisaje",     "paisaje",   True),
    (FOTOS / "visitantes",  "visitante", True),
]


def canon(label):
    return "flora" if label in ("flor", "planta", "arbol") else label


def gather(cap):
    """[(path, expected)] muestreado (hasta `cap` por fuente, determinista)."""
    items = []
    for folder, expected, rec in GT_SOURCES:
        if not folder.exists():
            continue
        it = folder.rglob("*") if rec else folder.glob("*")
        paths = sorted(p for p in it if p.is_file() and p.suffix.lower() in IMG_EXT)
        for p in paths[:cap]:
            items.append((str(p), expected))
    return items


def build_cache(items):
    """Encodea (o carga de cache) el embedding CLIP de cada imagen. Cache por path+mtime."""
    cache = {}
    if CACHE.exists():
        z = np.load(CACHE, allow_pickle=True)
        cache = {k: z[k] for k in z.files}
    out, n_new, t0 = {}, 0, time.time()
    for i, (path, _) in enumerate(items):
        try:
            key = f"{path}::{int(Path(path).stat().st_mtime)}"
        except OSError:
            continue
        if key in cache:
            out[key] = cache[key]
            continue
        try:
            out[key] = id_local.embed_image(path).astype(np.float32)
            n_new += 1
        except Exception as e:
            out[key] = np.zeros(512, np.float32)   # marca fallo (se ignora luego)
            print(f"  ! fallo encode {Path(path).name}: {type(e).__name__}")
        if n_new and n_new % 50 == 0:
            print(f"  encodeadas {n_new} nuevas… ({(time.time()-t0):.0f}s)")
    if n_new:
        WORK.mkdir(exist_ok=True)
        merged = {**cache, **out}
        np.savez(CACHE, **merged)
        print(f"  cache: +{n_new} nuevas, total {len(merged)} → {CACHE.name}")
    return out


def evaluate(items, cache, prompt_sets, thr, margin, per_cat_thr=None):
    """Devuelve dict con conteos por categoría esperada y globales."""
    from collections import defaultdict
    stats = defaultdict(lambda: {"n": 0, "correct": 0, "fp": 0, "abstain": 0, "fp_into": defaultdict(int)})
    for path, expected in items:
        try:
            key = f"{path}::{int(Path(path).stat().st_mtime)}"
        except OSError:
            continue
        vec = cache.get(key)
        if vec is None or not vec.any():
            continue
        scores = id_local.category_scores_from_embedding(vec, prompt_sets)
        top_label, top_p = scores[0]
        second_p = scores[1][1] if len(scores) > 1 else 0.0
        pred = canon(top_label)
        t = (per_cat_thr or {}).get(pred, thr)
        s = stats[expected]
        s["n"] += 1
        if top_p < t or (top_p - second_p) < margin:
            s["abstain"] += 1
        elif pred == expected:
            s["correct"] += 1
        else:
            s["fp"] += 1
            s["fp_into"][pred] += 1
    return stats


def report(stats, title):
    print(f"\n=== {title} ===")
    print(f"  {'categoría':16} {'N':>4} {'✓correct':>8} {'✗FP':>5} {'abst':>5} {'prec':>6} {'recall':>6}")
    tot_n = tot_c = tot_fp = tot_ab = 0
    for cat in sorted(stats):
        s = stats[cat]
        n, c, fp, ab = s["n"], s["correct"], s["fp"], s["abstain"]
        prec = c / (c + fp) if (c + fp) else float("nan")
        rec = c / n if n else float("nan")
        into = ",".join(f"{k}:{v}" for k, v in sorted(s["fp_into"].items(), key=lambda x: -x[1])[:3])
        print(f"  {cat:16} {n:>4} {c:>8} {fp:>5} {ab:>5} {prec:>6.2f} {rec:>6.2f}   {('→'+into) if into else ''}")
        tot_n += n; tot_c += c; tot_fp += fp; tot_ab += ab
    P = tot_c / (tot_c + tot_fp) if (tot_c + tot_fp) else float("nan")
    R = tot_c / tot_n if tot_n else float("nan")
    print(f"  {'TOTAL':16} {tot_n:>4} {tot_c:>8} {tot_fp:>5} {tot_ab:>5} {P:>6.2f} {R:>6.2f}")
    print(f"  → FP rate global: {tot_fp}/{tot_n} = {tot_fp/tot_n:.3f}   (constraint #1: minimizar)")
    return tot_fp, tot_n, P, R


def predicted_label_stats(items, cache, prompt_sets, thr, margin, per_cat_thr=None):
    """Precisión POR ETIQUETA PREDICHA (métrica app-visible): entre las imágenes
    que el clasificador asigna con confianza a X, ¿qué fracción es realmente X?"""
    from collections import defaultdict
    pred = defaultdict(lambda: {"assigned": 0, "correct": 0, "wrong_from": defaultdict(int)})
    for path, expected in items:
        try:
            key = f"{path}::{int(Path(path).stat().st_mtime)}"
        except OSError:
            continue
        vec = cache.get(key)
        if vec is None or not vec.any():
            continue
        scores = id_local.category_scores_from_embedding(vec, prompt_sets)
        top_label, top_p = scores[0]
        second_p = scores[1][1] if len(scores) > 1 else 0.0
        p = canon(top_label)
        t = (per_cat_thr or {}).get(p, thr)
        if top_p < t or (top_p - second_p) < margin:
            continue                                    # abstención → no cuenta
        pred[p]["assigned"] += 1
        if p == expected:
            pred[p]["correct"] += 1
        else:
            pred[p]["wrong_from"][expected] += 1
    return pred


def calibrate(items, cache, prompt_sets, target_prec, margin):
    """Por categoría predicha, halla el menor umbral que da precisión ≥ target.
    Devuelve {cat: {thr, assigned, correct, prec, recall_of_gt}}. Categoría que NUNCA
    alcanza el target → thr=None (excluir del auto → _sin_clasificar)."""
    grid = [round(x, 2) for x in np.arange(0.30, 0.985, 0.02)]
    gt_counts = {}
    for _, e in items:
        gt_counts[e] = gt_counts.get(e, 0) + 1
    result = {}
    cats = set(k for k in prompt_sets) | {"flora"}
    for cat in cats:
        best = None
        for t in grid:
            ps = predicted_label_stats(items, cache, prompt_sets, thr=0.0, margin=margin,
                                       per_cat_thr={cat: t})
            s = ps.get(cat, {"assigned": 0, "correct": 0})
            a, c = s["assigned"], s["correct"]
            prec = c / a if a else 1.0
            if a > 0 and prec >= target_prec:
                best = {"thr": t, "assigned": a, "correct": c, "prec": prec,
                        "recall": c / gt_counts.get(cat, 1)}
                break
        result[cat] = best
    return result


def main():
    cap = int(sys.argv[sys.argv.index("--cap") + 1]) if "--cap" in sys.argv else 80
    items = gather(cap)
    print(f"Ground-truth: {len(items)} imágenes de {len(set(e for _, e in items))} categorías (cap {cap}/fuente)")
    cache = build_cache(items)

    stats = evaluate(items, cache, id_local.CATEGORY_PROMPTS, thr=0.40, margin=0.0)
    report(stats, "Baseline por categoría-esperada  (thr=0.40, margin=0)")

    # Precisión por etiqueta predicha (lo que se ve en la app)
    print("\n=== Precisión POR ETIQUETA PREDICHA  (thr=0.40, margin=0.10) ===")
    pl = predicted_label_stats(items, cache, id_local.CATEGORY_PROMPTS, thr=0.40, margin=0.10)
    print(f"  {'predicho':16} {'asignados':>9} {'✓':>4} {'prec':>6}   errores")
    for cat in sorted(pl):
        s = pl[cat]; a, c = s["assigned"], s["correct"]
        wf = ",".join(f"{k}:{v}" for k, v in sorted(s["wrong_from"].items(), key=lambda x: -x[1])[:3])
        print(f"  {cat:16} {a:>9} {c:>4} {(c/a if a else 1):>6.2f}   {wf}")

    if "--production" in sys.argv:
        # Aplica decide_category() (config de producción) y mide FP/recall finales.
        from collections import defaultdict
        pred = defaultdict(lambda: {"assigned": 0, "correct": 0, "wrong_from": defaultdict(int)})
        n_abstain = 0; n_total = 0
        gt_counts = defaultdict(int)
        for path, expected in items:
            gt_counts[expected] += 1
            try:
                key = f"{path}::{int(Path(path).stat().st_mtime)}"
            except OSError:
                continue
            vec = cache.get(key)
            if vec is None or not vec.any():
                continue
            n_total += 1
            scores = id_local.category_scores_from_embedding(vec, id_local.CATEGORY_PROMPTS)
            cat, _ = id_local.decide_category(scores)
            if cat is None:
                n_abstain += 1; continue
            p = canon(cat)
            pred[p]["assigned"] += 1
            if p == expected:
                pred[p]["correct"] += 1
            else:
                pred[p]["wrong_from"][expected] += 1
        print("\n=== CONFIG DE PRODUCCIÓN  decide_category()  — precisión por etiqueta ===")
        print(f"  {'predicho':16} {'asign':>6} {'✓':>4} {'prec':>6} {'recall_gt':>9}   errores")
        tot_a = tot_c = 0
        for cat in sorted(pred):
            s = pred[cat]; a, c = s["assigned"], s["correct"]
            wf = ",".join(f"{k}:{v}" for k, v in sorted(s["wrong_from"].items(), key=lambda x: -x[1])[:3])
            rec = c / gt_counts.get(cat, 1)
            print(f"  {cat:16} {a:>6} {c:>4} {(c/a if a else 1):>6.2f} {rec:>9.2f}   {wf}")
            tot_a += a; tot_c += c
        P = tot_c / tot_a if tot_a else float("nan")
        print(f"  {'TOTAL asignados':16} {tot_a:>6} {tot_c:>4} {P:>6.3f}")
        print(f"  → Falsos positivos: {tot_a - tot_c}/{tot_a} asignados = {(tot_a-tot_c)/tot_a if tot_a else 0:.3f}")
        print(f"  → Abstención (_sin_clasificar): {n_abstain}/{n_total} = {n_abstain/n_total:.3f}")
        print(f"  → Cobertura (clasificados correctos / total): {tot_c}/{n_total} = {tot_c/n_total:.3f}")

    if "--calibrate" in sys.argv:
        tgt = 0.97
        print(f"\n=== Calibración: umbral mínimo por categoría para precisión ≥ {tgt} (margin=0.12) ===")
        cal = calibrate(items, cache, id_local.CATEGORY_PROMPTS, target_prec=tgt, margin=0.12)
        print(f"  {'categoría':16} {'thr':>6} {'asign':>6} {'✓':>4} {'prec':>6} {'recall':>6}")
        for cat in sorted(cal):
            b = cal[cat]
            if b:
                print(f"  {cat:16} {b['thr']:>6.2f} {b['assigned']:>6} {b['correct']:>4} {b['prec']:>6.2f} {b['recall']:>6.2f}")
            else:
                print(f"  {cat:16} {'—':>6}   (no alcanza {tgt} → excluir del auto / _sin_clasificar)")


if __name__ == "__main__":
    main()
