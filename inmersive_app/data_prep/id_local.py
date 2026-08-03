"""
id_local.py — Motor de identificación LOCAL y gratuito ($0, offline, sin API).

Dos modelos, ambos corren en tu PC (CPU), licencia MIT:
  • CLIP (open_clip, pesos OpenAI ViT-B/32) → categoría gruesa. Cada categoría se
    representa con un ENSEMBLE de prompts (se promedian los embeddings de texto →
    un prototipo por categoría, más robusto que un solo prompt).
  • BioCLIP (pybioclip) en modo CERRADO contra el inventario de la reserva →
    especie. Al restringirlo a tu lista, NO PUEDE devolver una especie que no
    esté en la reserva (guardia anti-falso-positivo por construcción).

Los modelos se descargan UNA vez (Hugging Face) y luego funcionan sin internet.
Se cargan de forma perezosa (la primera vez que se usan) y una sola vez por proceso.

Diseño anti-falso-positivo: `category_scores()` devuelve la distribución completa;
la decisión de asignar vs `_sin_clasificar` (umbral por categoría + margen) vive en
el llamador (14_classify_photos.py / 19_classify_archive.py), calibrada con
eval_classifier.py sobre ground-truth.
"""

from functools import lru_cache

# Categoría gruesa: etiqueta ES → LISTA de prompts en inglés (CLIP puntúa mejor en
# inglés). Se promedian → un prototipo por categoría. Añadir prompts diversos sube
# la robustez; mantenerlos específicos evita solapamiento entre categorías.
CATEGORY_PROMPTS = {
    "ave": [
        "a photo of a wild bird", "a bird perched on a branch",
        "a hummingbird feeding", "a close-up of a bird",
    ],
    "mamifero": [
        "a photo of a wild mammal", "a squirrel on a tree",
        "a possum or small mammal", "a wild animal with fur",
    ],
    "anfibio": [
        "a photo of a frog", "a toad on the ground",
        "a small amphibian", "a tree frog",
    ],
    "reptil": [
        "a photo of a lizard", "a snake on the ground",
        "an anole or gecko lizard", "a reptile with scales and a long tail",
    ],
    "insecto": [
        "a close-up photo of an insect", "a butterfly on a flower",
        "a beetle", "a bee or wasp",
    ],
    "aracnido": [
        "a close-up photo of a spider", "a spider on its web",
        "a spider web with a spider",
    ],
    "flor": [
        "a close-up photo of a flower", "a blooming flower",
        "an orchid", "colorful flower petals",
    ],
    "planta": [
        "a photo of green foliage", "a small plant or shrub",
        "ferns and undergrowth", "leaves of a plant",
    ],
    "arbol": [
        "a photo of a large tree", "a forest canopy",
        "a tall tree trunk", "trees in a forest",
    ],
    "hongo": [
        "a photo of a mushroom", "fungi growing on wood",
        "a cluster of mushrooms on the forest floor",
    ],
    "aguas": [
        "a photo of a river", "a waterfall in the forest",
        "a stream of water", "a lake or pond",
    ],
    "visitante": [
        "a photo of a person", "a group of people posing",
        "people standing outdoors", "a portrait of people",
    ],
    # NOTA: `restauracion` (sembrar árboles / vivero) se QUITÓ del auto: es una
    # ACTIVIDAD, no un objeto visual → CLIP no la separa de visitante/paisaje
    # (precisión <0.35 a cualquier umbral, ver eval_classifier). Se cura a mano,
    # como eco_turismo y nuestra_historia. Ante la duda: _sin_clasificar.
    "infraestructura": [
        "a building or cabin", "a wooden house in the countryside",
        "a trail sign or fence", "a road or construction site",
    ],
    # MADERA CORTADA — clase sumidero, añadida tras auditar el bulk (2026-08-03).
    # CLIP no distingue «árbol» de «madera»: una MESA puntuaba arbol 0.83 con el 2º
    # a 0.06, así que ni el umbral ni el margen podían atajarla. Cinco de los siete
    # falsos positivos de `arbol` eran madera aserrada (mesa, tablones, contrachapado).
    # Una clase real sin etiqueta propia contamina a su vecina más cercana: dársela
    # es el arreglo, no subir el umbral. Va en AUTO_EXCLUDE → cae en _sin_clasificar.
    "madera": [
        "a wooden table", "a plank of sawn timber", "stacked wooden boards",
        "a plywood panel", "a wooden floor or ceiling", "cut logs stacked in a pile",
        "wooden furniture", "a carpentry workshop",
    ],
    "paisaje": [
        "a scenic landscape of mountains", "an aerial view of forested hills",
        "a panoramic view of a valley", "a drone photo of the countryside",
    ],
}

# Categorías que son organismos (candidatas a BioCLIP para especie).
ORGANISM_CATS = {"ave", "mamifero", "anfibio", "reptil", "insecto", "aracnido", "flor", "planta", "arbol", "hongo"}
# Categorías no-organismo (CLIP las resuelve; no van a BioCLIP).
NON_ORGANISM_CATS = {"aguas", "visitante", "infraestructura", "paisaje"}

# --- Configuración de decisión (calibrada con eval_classifier.py sobre ground-truth) ---
# Umbral mínimo de confianza CLIP por categoría para asignar (si no, _sin_clasificar).
# Calibrado para precisión alta (FP mínimo = constraint #1); ver bitácora en _archive_work.
CATEGORY_THRESHOLDS = {
    # Fauna con poco ground-truth (anfibio/aracnido/mamifero/insecto): umbral ALTO tras
    # auditar el bulk — la cola de baja confianza (0.5–0.7) eran falsos positivos
    # (cascada→aracnido, vegetación→mamifero); los reales están en 0.9–1.0.
    "ave": 0.92, "mamifero": 0.85, "anfibio": 0.93, "reptil": 0.82, "insecto": 0.82,
    "aracnido": 0.85, "flor": 0.66, "planta": 0.66, "arbol": 0.66, "hongo": 0.80,
    "paisaje": 0.76, "visitante": 0.52,
    # aguas: umbral ALTO (0.85). Verificado: 0 falsos-positivos sobre 341 imágenes de
    # ground-truth (nada de paisaje/flora/etc cae en aguas a 0.85); solo dispara con
    # agua muy clara (estanque, río). Sin GT positivo abundante → se mantiene estricto.
    "aguas": 0.85,
}
CATEGORY_MARGIN = 0.13          # el top debe superar al 2º por este margen
DEFAULT_THRESHOLD = 0.70        # categorías sin umbral propio
# Excluidas del auto (sin ground-truth fiable / no separables) → siempre _sin_clasificar.
# Se curan a mano, como eco_turismo y nuestra_historia. (infraestructura: se confunde
# con flora/paisaje en las tomas de la reserva, precisión <0.5 → mejor _sin_clasificar.)
# `madera` es una clase SUMIDERO: existe sólo para que la madera aserrada deje de
# caer en `arbol`. Nunca se publica como categoría — su destino es _sin_clasificar.
AUTO_EXCLUDE = {"infraestructura", "madera"}


def decide_category(scores):
    """scores: [(label, prob)] desc de category_scores. Devuelve (categoria|None, razón).
    None = _sin_clasificar (baja confianza, margen bajo, o categoría excluida)."""
    top, p = scores[0]
    second = scores[1][1] if len(scores) > 1 else 0.0
    if top in AUTO_EXCLUDE:
        return None, f"excluida del auto ({top})"
    thr = CATEGORY_THRESHOLDS.get(top, DEFAULT_THRESHOLD)
    if p < thr:
        return None, f"baja confianza ({top} {p:.2f} < {thr})"
    if (p - second) < CATEGORY_MARGIN:
        return None, f"margen bajo ({top} {p:.2f}, 2º {second:.2f})"
    return top, f"{top} {p:.2f} (margen {p - second:.2f})"


def decide_video(frame_scores):
    """Vota decide_category sobre los frames. Asigna solo si la MAYORÍA de los frames
    leídos coincide en la misma categoría, sin empate (anti-falso-positivo para video).
    Devuelve (categoria|None, razón)."""
    from collections import Counter
    if not frame_scores:
        return None, "sin frames legibles"
    votes = [decide_category(sc)[0] for sc in frame_scores]
    confident = [c for c in votes if c]
    if not confident:
        return None, "ningún frame confiable"
    c = Counter(confident)
    ranked = c.most_common()
    top, cnt = ranked[0]
    tie = len(ranked) > 1 and ranked[1][1] == cnt
    if cnt >= (len(votes) + 1) // 2 and not tie:      # mayoría de frames leídos, sin empate
        return top, f"video {cnt}/{len(votes)} frames → {top}"
    return None, f"video sin consenso ({dict(c)} de {len(votes)})"


# ---------- CLIP: modelo + embeddings ----------
@lru_cache(maxsize=1)
def _clip():
    import open_clip
    import torch
    torch.set_num_threads(max(1, min(8, (torch.get_num_threads() or 4))))
    # ViT-B-32-quickgelu: los pesos 'openai' se entrenaron con QuickGELU; usar la
    # variante correcta evita el mismatch que degrada los embeddings.
    model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32-quickgelu", pretrained="openai")
    model.eval()
    tok = open_clip.get_tokenizer("ViT-B-32-quickgelu")
    return model, preprocess, tok, torch


def embed_pil(img):
    """Embedding CLIP normalizado (numpy float32, 512) de una imagen PIL."""
    from PIL import ImageOps
    model, preprocess, _, torch = _clip()
    img = ImageOps.exif_transpose(img).convert("RGB")
    x = preprocess(img).unsqueeze(0)
    with torch.no_grad():
        f = model.encode_image(x)
        f = f / f.norm(dim=-1, keepdim=True)
    return f[0].cpu().numpy()


def embed_image(path):
    """Vector de imagen CLIP normalizado (numpy float32, dim 512)."""
    from PIL import Image
    return embed_pil(Image.open(path))


# ---------- Video: frames representativos → embeddings ----------
def video_frame_images(path, n=3):
    """Hasta n imágenes PIL muestreadas a lo largo del video (evita el 1er/último
    frame, a menudo negros). Tolerante a errores: [] si no se puede leer."""
    from PIL import Image
    import imageio
    out = []
    try:
        rd = imageio.get_reader(str(path), "ffmpeg")
    except Exception:
        return out
    try:
        meta = rd.get_meta_data()
        fps = meta.get("fps") or 25.0
        dur = meta.get("duration")
        nf = int(dur * fps) if dur else None
        if nf and nf > 1:
            qs = [0.5] if n == 1 else [(k + 1) / (n + 1) for k in range(n)]
            for q in qs:
                i = max(0, min(nf - 1, int(nf * q)))
                try:
                    out.append(Image.fromarray(rd.get_data(i)))
                except Exception:
                    pass
        else:                                   # sin metadata fiable → primeros frames
            for i, frame in enumerate(rd):
                if i % 15 == 5:
                    out.append(Image.fromarray(frame))
                if len(out) >= n:
                    break
    except Exception:
        pass
    finally:
        try:
            rd.close()
        except Exception:
            pass
    return out


def video_category_scores(path, n=3):
    """[(label,prob)] por cada frame muestreado del video. [] si no se pudo leer."""
    return [category_scores_from_embedding(embed_pil(img)) for img in video_frame_images(path, n)]


def embed_texts(prompts):
    """Matriz de embeddings de texto normalizados (numpy [n, 512])."""
    model, _, tok, torch = _clip()
    with torch.no_grad():
        t = model.encode_text(tok(list(prompts)))
        t = t / t.norm(dim=-1, keepdim=True)
    return t.cpu().numpy()


@lru_cache(maxsize=4)
def _prototypes(prompt_items):
    """prompt_items: tupla ((label,(p1,p2,...)),...) hashable → (labels, matriz prototipos).
    Prototipo = promedio (renormalizado) de los embeddings de los prompts de la categoría."""
    import numpy as np
    labels = [k for k, _ in prompt_items]
    protos = []
    for _, prompts in prompt_items:
        tv = embed_texts(prompts)              # [n,512]
        v = tv.mean(axis=0)
        v = v / (np.linalg.norm(v) + 1e-9)
        protos.append(v)
    return labels, np.stack(protos)            # [L,512]


def _prompt_items(prompt_sets):
    return tuple((k, tuple(v)) for k, v in prompt_sets.items())


def category_scores_from_embedding(vec, prompt_sets=None, temp=100.0):
    """Dado un embedding de imagen, devuelve [(label, prob)] desc (softmax de cos·temp)."""
    import numpy as np
    ps = prompt_sets or CATEGORY_PROMPTS
    labels, protos = _prototypes(_prompt_items(ps))
    sims = protos @ vec                         # coseno (todo normalizado)
    z = sims * (temp / 100.0) * 100.0
    z = z - z.max()
    e = np.exp(z)
    probs = e / e.sum()
    order = np.argsort(-probs)
    return [(labels[i], float(probs[i])) for i in order]


def category_scores(path, prompt_sets=None):
    """[(label, prob)] desc para una imagen (encode + softmax sobre prototipos)."""
    return category_scores_from_embedding(embed_image(path), prompt_sets)


def classify_category(path):
    """Compat: (categoria_es, score 0..1) de la mejor categoría."""
    top = category_scores(path)[0]
    return top[0], top[1]


# ---------- BioCLIP: especie (modo cerrado al inventario) ----------
@lru_cache(maxsize=1)
def _bioclip(sci_tuple):
    """sci_tuple: tupla de nombres científicos del inventario (hashable para cache).
    BioCLIP v1 (ViT-B/16): liviano para laptop; en modo cerrado la precisión es casi igual."""
    from bioclip import CustomLabelsClassifier, BIOCLIP_V1_MODEL_STR
    return CustomLabelsClassifier(cls_ary=list(sci_tuple), model_str=BIOCLIP_V1_MODEL_STR, device="cpu")


def identify_species(path, sci_names):
    """[(scientific_name, score)] desc, restringido al inventario."""
    clf = _bioclip(tuple(sci_names))
    preds = clf.predict(str(path))
    out = []
    for p in preds:
        sci = p.get("classification") or p.get("class") or p.get("label") or ""
        sc = p.get("score") or p.get("probability") or 0.0
        out.append((sci, float(sc)))
    out.sort(key=lambda x: x[1], reverse=True)
    return out
