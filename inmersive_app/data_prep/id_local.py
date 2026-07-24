"""
id_local.py — Motor de identificación LOCAL y gratuito ($0, offline, sin API).

Dos modelos, ambos corren en tu PC (CPU), licencia MIT:
  • CLIP (open_clip, pesos OpenAI ViT-B/32) → categoría gruesa entre 10 clases,
    incluidas las NO-organismo (persona / infraestructura / paisaje).
  • BioCLIP (pybioclip) en modo CERRADO contra el inventario de la reserva →
    especie. Al restringirlo a tu lista, NO PUEDE devolver una especie que no
    esté en la reserva (guardia anti-falso-positivo por construcción).

Los modelos se descargan UNA vez (Hugging Face) y luego funcionan sin internet.
Se cargan de forma perezosa (la primera vez que se usan) y una sola vez por proceso.
"""

from functools import lru_cache
from pathlib import Path

# Categoría gruesa (etiqueta ES → prompt descriptivo en inglés, que CLIP puntúa mejor).
CATEGORY_PROMPTS = {
    "ave":            "a photo of a wild bird",
    "mamifero":       "a photo of a wild mammal",
    "anfibio":        "a photo of a frog, toad or salamander",
    "insecto":        "a close-up photo of an insect or spider",
    "flor":           "a close-up photo of a flower or orchid",
    "planta":         "a photo of green foliage or a small plant",
    "arbol":          "a photo of a tree or forest canopy",
    "visitante":      "a photo of a person or people",
    "infraestructura": "a photo of a building, cabin, sign or trail structure",
    "paisaje":        "a scenic landscape photograph of mountains or forest",
}
# Cuáles categorías son organismos (van a BioCLIP para especie).
ORGANISM_CATS = {"ave", "mamifero", "anfibio", "insecto", "flor", "planta", "arbol"}


# ---------- CLIP: categoría gruesa ----------
@lru_cache(maxsize=1)
def _clip():
    import open_clip
    import torch
    torch.set_num_threads(max(1, min(4, (torch.get_num_threads() or 4))))  # amable con la laptop
    model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")
    model.eval()
    tok = open_clip.get_tokenizer("ViT-B-32")
    labels = list(CATEGORY_PROMPTS.keys())
    prompts = list(CATEGORY_PROMPTS.values())
    with torch.no_grad():
        tfeat = model.encode_text(tok(prompts))
        tfeat = tfeat / tfeat.norm(dim=-1, keepdim=True)
    return model, preprocess, labels, tfeat, torch


def classify_category(path):
    """Devuelve (categoria_es, score 0..1)."""
    from PIL import Image
    model, preprocess, labels, tfeat, torch = _clip()
    img = preprocess(Image.open(path).convert("RGB")).unsqueeze(0)
    with torch.no_grad():
        f = model.encode_image(img)
        f = f / f.norm(dim=-1, keepdim=True)
        probs = (100.0 * f @ tfeat.T).softmax(dim=-1)[0]
    i = int(probs.argmax())
    return labels[i], float(probs[i])


# ---------- BioCLIP: especie (modo cerrado al inventario) ----------
@lru_cache(maxsize=1)
def _bioclip(sci_tuple):
    """sci_tuple: tupla de nombres científicos del inventario (hashable para cache).
    Usa BioCLIP v1 (ViT-B/16): mucho más liviano que v2 (ViT-L/14) para correr en
    una laptop; en modo cerrado la precisión es prácticamente igual."""
    from bioclip import CustomLabelsClassifier, BIOCLIP_V1_MODEL_STR
    return CustomLabelsClassifier(cls_ary=list(sci_tuple), model_str=BIOCLIP_V1_MODEL_STR, device="cpu")


def identify_species(path, sci_names):
    """Devuelve [(scientific_name, score)] ordenado desc, restringido al inventario."""
    clf = _bioclip(tuple(sci_names))
    preds = clf.predict(str(path))
    # pybioclip devuelve una lista de dicts; normalizamos las claves.
    out = []
    for p in preds:
        sci = p.get("classification") or p.get("class") or p.get("label") or ""
        sc = p.get("score") or p.get("probability") or 0.0
        out.append((sci, float(sc)))
    out.sort(key=lambda x: x[1], reverse=True)
    return out
