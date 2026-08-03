#!/usr/bin/env python3
"""
24_eval_bulk.py — Mide la precisión REAL del clasificador sobre el volumen que ya
etiquetó, no sobre el ground truth con el que se calibró.

Por qué existe: `eval_classifier.py` compara contra carpetas organizadas a mano.
Eso mide bien las clases que esas carpetas contienen — y es ciego a todo lo demás.
El archivo real contiene clases que el GT nunca tuvo, y ahí es donde aparecen los
errores con confianza alta (una Asteraceae amarilla etiquetada «orquidea» a 0.99).
Sin etiquetas sobre el volumen real, cualquier cambio de umbral es una corazonada.

Tres pasos:

  1. `sample`  — muestra estratificada del catálogo + miniaturas + una hoja de
                 contacto HTML que funciona sin servidor ni internet.
  2. (humano)  — marcar ✓/✗ en la hoja y bajar `eval_verdicts.json`.
  3. `report`  — precisión por categoría con intervalo de Wilson, distribución de
                 confianza de los ERRORES, y el umbral que habría atajado cada
                 falso positivo (con lo que cuesta en cobertura).

Uso:
  python data_prep/24_eval_bulk.py sample                    # 30 por categoría
  python data_prep/24_eval_bulk.py sample --per-category 40
  python data_prep/24_eval_bulk.py report
  python data_prep/24_eval_bulk.py rescore --write           # ¿mejoró la calibración?
  python data_prep/24_eval_bulk.py selftest                  # sin modelos ni fotos

`rescore` re-puntúa desde los ORIGINALES con la config actual de id_local y compara
contra los mismos veredictos humanos: es la prueba de que tocar prompts o umbrales
mejoró algo. No toca el catálogo ni mueve archivos; escribe en `_archive_work/eval/`
y los informes publicables en `docs/`.
"""

import argparse
import json
import math
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                                    # inmersive_app/
CANTARES = ROOT.parent                                # Cantares/
WORK = HERE / "_archive_work"
CATALOG = WORK / "catalog_fotos-reserva-cantares.json"
OUT = WORK / "eval"
THUMBS = OUT / "thumbs"
SAMPLE_JSON = OUT / "eval_sample.json"
SHEET = OUT / "eval_sheet.html"
VERDICTS = OUT / "eval_verdicts.json"
# El informe es el único artefacto publicable: texto, sin imágenes ni rutas del
# archivo familiar. Todo lo demás (miniaturas, catálogo, veredictos) vive en
# _archive_work/, que está en .gitignore — este repo es público.
REPORT = ROOT / "docs" / "EVAL_CLASIFICADOR.md"

VID_EXT = {".mp4", ".mov", ".m4v", ".avi"}
UNCLASSIFIED = "_sin_clasificar"
SEED = 20260803          # fijo: la muestra debe poder reproducirse
THUMB_PX = 400           # legible en pantalla de portátil sin inflar la carpeta

# Etiquetas para el desplegable de re-etiquetado. Espejo de CATEGORY_PROMPTS en
# id_local.py; se lee de ahí cuando el módulo carga, con este respaldo si no.
FALLBACK_LABELS = ["ave", "mamifero", "anfibio", "reptil", "insecto", "aracnido",
                   "hongo", "arbol", "flor", "planta", "paisaje", "aguas",
                   "visitante", "infraestructura"]


# ---------------------------------------------------------------- pura: estadística
def wilson(k, n, z=1.96):
    """Intervalo de Wilson para una proporción. Se usa en vez del normal porque
    aquí n es pequeño (30 por categoría) y p suele estar cerca de 1, donde el
    intervalo normal da límites por encima de 1 o anchuras absurdas."""
    if n == 0:
        return (0.0, 0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (p, max(0.0, centre - half), min(1.0, centre + half))


def threshold_to_kill_fps(items):
    """Umbral mínimo que dejaría FUERA a todos los falsos positivos de una
    categoría, y cuántos aciertos se pierden por el camino.

    `items` = [(confianza, es_correcto)]. Devuelve (umbral, aciertos_perdidos,
    aciertos_totales). Umbral = (confianza del peor FP) + epsilon; None si no hay
    FPs. Si un FP tiene MÁS confianza que todo acierto, ningún umbral lo salva:
    se devuelve el umbral igualmente y el coste lo dirá (se pierde todo)."""
    fps = [c for c, ok in items if not ok]
    oks = [c for c, ok in items if ok]
    if not fps:
        return (None, 0, len(oks))
    thr = round(max(fps) + 0.01, 4)
    return (thr, sum(1 for c in oks if c < thr), len(oks))


def threshold_verdict(lost, n_ok):
    """¿Vale la pena subir el umbral? Se juzga por lo que CUESTA en cobertura.
    Las bandas son de criterio, no de teoría: hasta ~15% de aciertos perdidos el
    umbral es la herramienta correcta; por encima de la mitad, el error tiene
    tanta confianza como el acierto y ningún umbral los separa — hay que tocar
    los prompts o añadir una clase."""
    if not n_ok:
        return "sin aciertos con que comparar"
    frac = lost / n_ok
    if frac <= 0.15:
        return "subir el umbral es viable"
    if frac <= 0.5:
        return f"caro: cuesta {frac:.0%} de la cobertura"
    return "**el umbral no sirve** — el error tiene tanta confianza como el acierto"


def stratify(rows, per_category, seed=SEED):
    """Muestra estratificada: hasta `per_category` por categoría, TODAS las de las
    categorías pequeñas. Las clases diminutas (reptil=6, hongo=4) son justo donde
    se sospecha el error, así que se toman enteras en vez de proporcionalmente —
    un muestreo proporcional las dejaría con 0 o 1 elemento y sin poder medirlas."""
    by_cat = defaultdict(list)
    for r in rows:
        by_cat[r.get("category") or UNCLASSIFIED].append(r)
    rng = random.Random(seed)
    out = []
    for cat in sorted(by_cat):
        pool = sorted(by_cat[cat], key=lambda r: r["key"])   # orden estable
        if len(pool) > per_category:
            pool = rng.sample(pool, per_category)
        out.extend(pool)
    return out


# ---------------------------------------------------------------- miniaturas
def make_thumb(src, dst):
    """Miniatura de una foto o de un frame de video. Reutiliza el extractor de
    frames de id_local (imageio+ffmpeg) en vez de duplicarlo."""
    from PIL import Image, ImageOps
    if src.suffix.lower() in VID_EXT:
        sys.path.insert(0, str(HERE))
        import id_local
        frames = id_local.video_frame_images(src, n=1)
        if not frames:
            return False
        img = frames[0]
    else:
        img = Image.open(src)
        img = ImageOps.exif_transpose(img)
    img = img.convert("RGB")
    img.thumbnail((THUMB_PX, THUMB_PX))
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "JPEG", quality=72, optimize=True)
    return True


# ---------------------------------------------------------------- hoja de contacto
def build_sheet(sample, labels):
    """HTML autocontenido: sin servidor, sin red, sin dependencias. Las miniaturas
    se referencian relativas (thumbs/NNN.jpg) y el veredicto se guarda en
    localStorage a cada tecla, para que cerrar la pestaña no borre una hora de
    trabajo."""
    cards = []
    for it in sample:
        sp = it.get("scientific_name") or ""
        cards.append(
            f'<figure class="c" data-i="{it["i"]}" data-cat="{it["category"]}" '
            f'data-conf="{it["confidence"]}">'
            f'<img loading="lazy" src="thumbs/{it["i"]:04d}.jpg" alt="">'
            f'<figcaption><b>{it["category"]}</b> <span class=cf>{it["confidence"]:.2f}</span>'
            f'{f"<i>{sp}</i>" if sp else ""}'
            f'<span class=fn>{it["file"]}</span></figcaption>'
            f'<div class="btns"><button data-v="ok">✓</button><button data-v="bad">✗</button>'
            f'<select class="rl"><option value="">— era en realidad —</option>'
            + "".join(f'<option value="{l}">{l}</option>' for l in labels + [UNCLASSIFIED])
            + "</select></div></figure>"
        )
    return SHEET_TMPL.replace("__CARDS__", "\n".join(cards)).replace("__N__", str(len(sample)))


SHEET_TMPL = """<!doctype html>
<meta charset="utf-8">
<title>Cantares — auditoría del clasificador</title>
<style>
 body{font:15px/1.45 system-ui,sans-serif;margin:0;background:#12161d;color:#e8eef5}
 header{position:sticky;top:0;background:#0a0e1d;padding:10px 16px;z-index:5;
   display:flex;gap:16px;align-items:center;box-shadow:0 2px 12px #0008}
 h1{font-size:16px;margin:0;font-weight:600}
 .prog{font-variant-numeric:tabular-nums;color:#9fb3c8}
 button.dl{margin-left:auto;background:#007a35;color:#fff;border:0;border-radius:8px;
   padding:8px 14px;font-size:14px;cursor:pointer}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;padding:14px}
 .c{margin:0;background:#1b2230;border-radius:12px;overflow:hidden;border:2px solid transparent}
 .c.ok{border-color:#2e7d32}.c.bad{border-color:#c0392b}
 .c img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#000;cursor:zoom-in}
 figcaption{padding:7px 9px;font-size:12.5px}
 .cf{color:#fab814;margin-left:6px}
 figcaption i{display:block;color:#7fc4e8;font-size:12px}
 .fn{display:block;color:#6c7c8c;font-size:10.5px;word-break:break-all;margin-top:3px}
 .btns{display:flex;gap:5px;padding:0 9px 9px}
 .btns button{flex:0 0 40px;font-size:15px;border:0;border-radius:7px;padding:5px;cursor:pointer;
   background:#2b3546;color:#e8eef5}
 .c.ok .btns button[data-v=ok]{background:#2e7d32}
 .c.bad .btns button[data-v=bad]{background:#c0392b}
 .rl{flex:1;min-width:0;background:#2b3546;color:#e8eef5;border:0;border-radius:7px;font-size:12px}
 #lb{position:fixed;inset:0;background:#000d;display:none;place-items:center;z-index:10}
 #lb img{max-width:96vw;max-height:96vh}
 .hint{color:#9fb3c8;font-size:13px}
</style>
<header>
  <h1>Auditoría del clasificador</h1>
  <span class="prog"><b id="done">0</b>/__N__ · <span id="pc">0%</span></span>
  <span class="hint">✓ correcto · ✗ error (y elige qué era) · clic en la foto para ampliar</span>
  <button class="dl" id="dl">Descargar veredictos</button>
</header>
<div class="grid">__CARDS__</div>
<div id="lb"><img alt=""></div>
<script>
const KEY = 'cantares_eval_v1';
const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
const cards = [...document.querySelectorAll('.c')];
function paint(c) {
  const v = saved[c.dataset.i];
  c.classList.toggle('ok', v && v.verdict === 'ok');
  c.classList.toggle('bad', v && v.verdict === 'bad');
  if (v && v.truth) c.querySelector('.rl').value = v.truth;
}
function progress() {
  const n = Object.keys(saved).length;
  document.getElementById('done').textContent = n;
  document.getElementById('pc').textContent = Math.round(n / cards.length * 100) + '%';
}
function set(c, verdict, truth) {
  const i = c.dataset.i;
  saved[i] = { i: +i, verdict, truth: truth || (saved[i] && saved[i].truth) || '',
               category: c.dataset.cat, confidence: +c.dataset.conf };
  // Guardar en cada tecla: cerrar la pestaña no debe costar una hora de trabajo.
  localStorage.setItem(KEY, JSON.stringify(saved));
  paint(c); progress();
}
cards.forEach((c) => {
  paint(c);
  c.querySelectorAll('.btns button').forEach((b) =>
    b.onclick = () => set(c, b.dataset.v));
  c.querySelector('.rl').onchange = (e) => set(c, 'bad', e.target.value);
  c.querySelector('img').onclick = () => {
    const lb = document.getElementById('lb');
    lb.querySelector('img').src = c.querySelector('img').src;
    lb.style.display = 'grid';
  };
});
document.getElementById('lb').onclick = (e) => e.currentTarget.style.display = 'none';
progress();
document.getElementById('dl').onclick = () => {
  const blob = new Blob([JSON.stringify(Object.values(saved), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'eval_verdicts.json'; a.click();
};
</script>
"""


# ---------------------------------------------------------------- comandos
def cmd_sample(args):
    doc = json.loads(CATALOG.read_text(encoding="utf-8"))
    base = Path(doc["base"])
    rows = doc["items"]
    labelled = [r for r in rows if (r.get("category") or UNCLASSIFIED) != UNCLASSIFIED]
    print(f"catálogo: {len(rows)} entradas · {len(labelled)} etiquetadas "
          f"({len(labelled)/len(rows):.1%}) · {len(rows)-len(labelled)} sin clasificar")

    sample = stratify(labelled, args.per_category)
    counts = Counter(r["category"] for r in sample)
    print(f"\nmuestra: {len(sample)} imágenes")
    total = Counter(r["category"] for r in labelled)
    for cat in sorted(counts):
        print(f"  {cat:16s} {counts[cat]:3d} de {total[cat]:4d}")

    try:
        sys.path.insert(0, str(HERE))
        import id_local
        labels = list(id_local.CATEGORY_PROMPTS.keys())
    except Exception as e:                       # sin pesos/red: la hoja no los necesita
        print(f"\n(id_local no disponible: {e}; uso etiquetas de respaldo)")
        labels = FALLBACK_LABELS

    OUT.mkdir(parents=True, exist_ok=True)
    items, failed = [], []
    for i, r in enumerate(sample):
        src = base / r["file"]
        dst = THUMBS / f"{i:04d}.jpg"
        if not dst.exists():
            try:
                if not make_thumb(src, dst):
                    failed.append(r["file"]); continue
            except Exception as e:
                failed.append(f'{r["file"]} ({e})'); continue
        items.append({"i": i, "key": r["key"], "file": r["file"], "category": r["category"],
                      "confidence": float(r.get("confidence") or 0),
                      "scientific_name": r.get("scientific_name"),
                      "kind": r.get("kind", "photo")})
        if (i + 1) % 50 == 0:
            print(f"  miniaturas {i+1}/{len(sample)}…", flush=True)

    SAMPLE_JSON.write_text(json.dumps(
        {"seed": SEED, "per_category": args.per_category, "n": len(items), "items": items},
        ensure_ascii=False, indent=1), encoding="utf-8")
    SHEET.write_text(build_sheet(items, labels), encoding="utf-8")

    print(f"\n✓ {len(items)} miniaturas → {THUMBS}")
    if failed:
        print(f"⚠ {len(failed)} sin miniatura (ilegibles), excluidas de la muestra:")
        for f in failed[:8]:
            print(f"    {f}")
    print(f"✓ hoja de contacto → {SHEET}")
    print(f"\nAbre la hoja en el navegador, marca ✓/✗, pulsa «Descargar veredictos»")
    print(f"y guarda el archivo como:\n  {VERDICTS}\nLuego: python data_prep/24_eval_bulk.py report")


def cmd_report(args):
    if not VERDICTS.exists():
        sys.exit(f"Falta {VERDICTS}. Marca la hoja y baja los veredictos primero.")
    verdicts = json.loads(VERDICTS.read_text(encoding="utf-8"))
    sample = json.loads(SAMPLE_JSON.read_text(encoding="utf-8"))
    by_i = {it["i"]: it for it in sample["items"]}
    doc = json.loads(CATALOG.read_text(encoding="utf-8"))
    rows = doc["items"]
    n_all = len(rows)
    n_unc = sum(1 for r in rows if (r.get("category") or UNCLASSIFIED) == UNCLASSIFIED)
    total = Counter((r.get("category") or UNCLASSIFIED) for r in rows)

    judged = [v for v in verdicts if v.get("verdict") in ("ok", "bad")]
    per_cat = defaultdict(list)      # cat → [(conf, ok)]
    confusion = defaultdict(Counter)  # cat predicha → Counter(verdad)
    for v in judged:
        it = by_i.get(v["i"])
        if not it:
            continue
        ok = v["verdict"] == "ok"
        per_cat[it["category"]].append((it["confidence"], ok))
        if not ok:
            confusion[it["category"]][v.get("truth") or "(sin especificar)"] += 1

    L = []
    L.append("# Precisión del clasificador sobre el volumen real\n")
    L.append(f"Catálogo: **{n_all}** entradas · **{n_all - n_unc}** etiquetadas "
             f"({(n_all-n_unc)/n_all:.1%}) · **{n_unc}** sin clasificar "
             f"(abstención {n_unc/n_all:.1%}).\n")
    L.append(f"Muestra auditada: **{len(judged)}** de {sample['n']} "
             f"(semilla {sample['seed']}, hasta {sample['per_category']} por categoría).\n")
    L.append("La abstención NO es un error: es el diseño. Lo que se mide aquí es la "
             "precisión de lo que el modelo **sí** se atrevió a etiquetar.\n")

    L.append("\n## Precisión por categoría\n")
    L.append("| categoría | auditadas | correctas | precisión | IC 95% (Wilson) | en el catálogo |")
    L.append("|---|---:|---:|---:|---|---:|")
    order = sorted(per_cat, key=lambda c: (wilson(sum(1 for _, o in per_cat[c] if o),
                                                  len(per_cat[c]))[0], -len(per_cat[c])))
    for cat in order:
        items = per_cat[cat]
        k = sum(1 for _, ok in items if ok)
        p, lo, hi = wilson(k, len(items))
        L.append(f"| `{cat}` | {len(items)} | {k} | {p:.0%} | {lo:.0%} – {hi:.0%} | {total[cat]} |")
    all_items = [x for v in per_cat.values() for x in v]
    k = sum(1 for _, ok in all_items if ok)
    p, lo, hi = wilson(k, len(all_items))
    L.append(f"| **global** | **{len(all_items)}** | **{k}** | **{p:.0%}** | "
             f"**{lo:.0%} – {hi:.0%}** | **{n_all - n_unc}** |")
    L.append("\nOrdenado de peor a mejor. Una categoría con pocas auditadas tiene un "
             "intervalo ancho: no se puede concluir nada de ella todavía.\n")

    L.append("\n## Confianza: aciertos vs errores\n")
    L.append("Si los errores viven a confianza baja, subir el umbral los mata barato. "
             "Si viven a confianza alta, el umbral no es la herramienta.\n")
    L.append("| categoría | confianza media acierto | confianza media error | peor error |")
    L.append("|---|---:|---:|---:|")
    for cat in order:
        items = per_cat[cat]
        oks = [c for c, o in items if o]
        bad = [c for c, o in items if not o]
        L.append(f"| `{cat}` | {sum(oks)/len(oks):.2f} | "
                 f"{(sum(bad)/len(bad)):.2f} | {max(bad):.2f} |" if bad and oks else
                 f"| `{cat}` | {(sum(oks)/len(oks) if oks else 0):.2f} | — | — |")

    L.append("\n## Umbral que atajaría cada falso positivo\n")
    L.append("| categoría | umbral necesario | aciertos perdidos | veredicto |")
    L.append("|---|---:|---:|---|")
    for cat in order:
        thr, lost, n_ok = threshold_to_kill_fps(per_cat[cat])
        if thr is None:
            L.append(f"| `{cat}` | — | — | sin falsos positivos en la muestra |")
        else:
            L.append(f"| `{cat}` | {thr:.2f} | {lost}/{n_ok} | {threshold_verdict(lost, n_ok)} |")
    L.append("\nPerder cobertura no es gratis pero tampoco es un error: lo que se pierde "
             "cae en `_sin_clasificar` y se revisa a mano. Lo que no se puede aceptar es "
             "un error con confianza alta.\n")

    L.append("\n## Con qué se confunde\n")
    if confusion:
        L.append("| predijo | era en realidad | veces |")
        L.append("|---|---|---:|")
        for cat in sorted(confusion):
            for truth, n in confusion[cat].most_common():
                L.append(f"| `{cat}` | `{truth}` | {n} |")
        L.append("\nUna categoría que absorbe sistemáticamente otra suele significar que "
                 "a la lista de etiquetas le falta una clase, no que el umbral esté mal.\n")
    else:
        L.append("Ningún error marcado.\n")

    REPORT.write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L))
    print(f"\n✓ {REPORT}")


def cmd_rescore(args):
    """Re-puntúa las miniaturas ya auditadas con la configuración ACTUAL de
    id_local y compara contra los veredictos. Es la prueba de que un cambio de
    prompts o umbrales mejora de verdad: mismas imágenes, mismas etiquetas
    humanas, antes y después. Sin esto, tocar la calibración es a ciegas."""
    from PIL import Image
    sys.path.insert(0, str(HERE))
    import id_local

    verdicts = json.loads(VERDICTS.read_text(encoding="utf-8"))
    sample = json.loads(SAMPLE_JSON.read_text(encoding="utf-8"))
    by_i = {it["i"]: it for it in sample["items"]}
    base = Path(json.loads(CATALOG.read_text(encoding="utf-8"))["base"])
    judged = [v for v in verdicts if v.get("verdict") in ("ok", "bad")]
    print(f"re-puntuando {len(judged)} imágenes auditadas (carga el modelo una vez)…\n")

    def image_for(it):
        """El ORIGINAL, no la miniatura. Puntuar la miniatura mete un re-muestreo
        extra (4000→400→224 en vez de 4000→224) que mueve la confianza unas
        centésimas — suficiente para cruzar un umbral y hacer creer que el cambio
        de calibración causó algo que en realidad causó el JPEG intermedio.
        Sólo los videos caen a la miniatura, que ya es un frame extraído."""
        src = base / it["file"]
        if it.get("kind") == "video" or not src.exists():
            return Image.open(THUMBS / f'{it["i"]:04d}.jpg')
        from PIL import ImageOps
        return ImageOps.exif_transpose(Image.open(src))

    moved, kept_fp, lost_ok, still = [], [], [], 0
    for n, v in enumerate(judged):
        it = by_i.get(v["i"])
        if not it:
            continue
        scores = id_local.category_scores_from_embedding(id_local.embed_pil(image_for(it)))
        new_cat, reason = id_local.decide_category(scores)
        was_ok = v["verdict"] == "ok"
        if was_ok and new_cat == it["category"]:
            still += 1
        elif was_ok:
            lost_ok.append((v["i"], it["category"], new_cat, reason))
        elif new_cat is None or new_cat != it["category"]:
            moved.append((v["i"], it["category"], new_cat, reason))
        else:
            kept_fp.append((v["i"], it["category"], v.get("truth"), reason))
        if (n + 1) % 40 == 0:
            print(f"  {n+1}/{len(judged)}…", flush=True)

    n_fp = sum(1 for v in judged if v["verdict"] == "bad")
    n_ok = len(judged) - n_fp
    print(f"\n{'='*66}\nFALSOS POSITIVOS ({n_fp} auditados)")
    print(f"  corregidos (ya no se publican): {len(moved)}")
    for i, old, new, why in moved:
        print(f"    #{i:<4} {old:14s} → {new or '_sin_clasificar':16s} {why}")
    print(f"  siguen mal: {len(kept_fp)}")
    for i, old, truth, why in kept_fp:
        print(f"    #{i:<4} {old:14s} (era {truth}) {why}")
    print(f"\nACIERTOS ({n_ok} auditados)")
    print(f"  se mantienen: {still}   perdidos a _sin_clasificar/otra: {len(lost_ok)}")
    for i, old, new, why in lost_ok[:15]:
        print(f"    #{i:<4} {old:14s} → {new or '_sin_clasificar':16s} {why}")
    if len(lost_ok) > 15:
        print(f"    … y {len(lost_ok)-15} más")
    published = still + len(kept_fp)
    prec = still / published if published else 0
    print(f"\nPrecisión de lo que SEGUIRÍA publicándose: {prec:.0%} "
          f"({still} correctos / {published} publicados)")
    print(f"Cobertura: {published}/{len(judged)} "
          f"({published/len(judged):.0%} — el resto se revisa a mano)")

    if args.write:
        L = ["# Recalibración del clasificador\n",
             "Generado por `24_eval_bulk.py rescore --write`: re-puntúa desde los "
             "ORIGINALES las mismas imágenes auditadas y aplica la configuración "
             "actual de `id_local.py`. Compara contra los veredictos humanos, así "
             "que mide el efecto real de un cambio de prompts o umbrales.\n",
             f"Base: **{len(judged)}** imágenes auditadas "
             f"({n_ok} correctas, {n_fp} falsos positivos).\n",
             "\n## Resultado\n",
             "| | antes | después |", "|---|---:|---:|",
             f"| falsos positivos publicados | {n_fp} | {len(kept_fp)} |",
             f"| aciertos publicados | {n_ok} | {still} |",
             f"| precisión de lo publicado | {n_ok/len(judged):.0%} | **{prec:.0%}** |",
             f"| cobertura | 100% | **{published/len(judged):.0%}** |",
             "\nLo que sale de «publicado» no se pierde: cae en `_sin_clasificar` y "
             "se revisa a mano. Un error con confianza alta sí es una pérdida.\n",
             f"\n## Falsos positivos corregidos ({len(moved)})\n",
             "| # | etiqueta vieja | ahora | por qué |", "|---:|---|---|---|"]
        L += [f"| {i} | `{old}` | `{new or '_sin_clasificar'}` | {why} |" for i, old, new, why in moved]
        L += [f"\n## Falsos positivos que siguen ({len(kept_fp)})\n",
              "| # | etiqueta | era en realidad | confianza |", "|---:|---|---|---|"]
        L += [f"| {i} | `{old}` | `{truth}` | {why} |" for i, old, truth, why in kept_fp]
        L += [f"\n## Aciertos perdidos a revisión manual ({len(lost_ok)})\n",
              "Coste de la recalibración. Cada línea es una foto correcta que ahora "
              "hay que clasificar a mano.\n",
              "| # | era | ahora | por qué |", "|---:|---|---|---|"]
        L += [f"| {i} | `{old}` | `{new or '_sin_clasificar'}` | {why} |" for i, old, new, why in lost_ok]
        p = ROOT / "docs" / "EVAL_RECALIBRACION.md"
        p.write_text("\n".join(L) + "\n", encoding="utf-8")
        print(f"\n✓ {p}")


def cmd_selftest(args):
    """Comprueba la lógica pura sin modelos, sin fotos y sin red."""
    p, lo, hi = wilson(30, 30)
    assert p == 1.0 and lo < 1.0 and hi == 1.0, (p, lo, hi)
    p, lo, hi = wilson(27, 30)
    assert abs(p - 0.9) < 1e-9 and lo < 0.9 < hi, (p, lo, hi)
    assert wilson(0, 0) == (0.0, 0.0, 0.0)

    # errores a confianza baja → un umbral barato los mata
    thr, lost, n = threshold_to_kill_fps([(0.99, True), (0.95, True), (0.40, False)])
    assert thr == 0.41 and lost == 0 and n == 2, (thr, lost, n)
    # error MÁS confiado que los aciertos → el umbral se lleva todo por delante
    thr, lost, n = threshold_to_kill_fps([(0.80, True), (0.70, True), (0.99, False)])
    assert thr == 1.0 and lost == 2 and n == 2, (thr, lost, n)
    assert threshold_to_kill_fps([(0.9, True)]) == (None, 0, 1)

    assert threshold_verdict(0, 20) == "subir el umbral es viable"
    assert threshold_verdict(3, 20) == "subir el umbral es viable"        # 15% justo
    assert "caro" in threshold_verdict(9, 20)                             # 45%: no es viable
    assert "no sirve" in threshold_verdict(15, 20)                        # 75%

    # las clases diminutas se toman enteras; las grandes se recortan
    rows = ([{"key": f"a{i}", "category": "ave"} for i in range(100)]
            + [{"key": f"r{i}", "category": "reptil"} for i in range(6)])
    s = stratify(rows, 30)
    c = Counter(r["category"] for r in s)
    assert c["ave"] == 30 and c["reptil"] == 6, c
    # misma semilla → misma muestra (auditoría reproducible)
    assert [r["key"] for r in stratify(rows, 30)] == [r["key"] for r in s]

    print("selftest 24_eval_bulk: 12/12 OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("sample", help="muestra estratificada + hoja de contacto")
    s.add_argument("--per-category", type=int, default=30)
    s.set_defaults(fn=cmd_sample)
    r = sub.add_parser("report", help="veredictos marcados → EVAL.md")
    r.set_defaults(fn=cmd_report)
    rs = sub.add_parser("rescore", help="re-puntúa lo auditado con la config actual")
    rs.add_argument("--write", action="store_true", help="escribe docs/EVAL_RECALIBRACION.md")
    rs.set_defaults(fn=cmd_rescore)
    t = sub.add_parser("selftest", help="lógica pura, sin modelos ni fotos")
    t.set_defaults(fn=cmd_selftest)
    args = ap.parse_args()
    if not args.cmd:
        ap.print_help(); sys.exit(0)
    args.fn(args)


if __name__ == "__main__":
    main()
