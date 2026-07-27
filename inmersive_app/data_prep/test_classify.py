"""Checks de la lógica de decisión (sin modelos ni red): common_dirname (14),
confirm_species (14), id_local.decide_category y decide_video."""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import id_local

spec = importlib.util.spec_from_file_location("clf", HERE / "14_classify_photos.py")
clf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clf)

# --- common_dirname: carpeta = común, desambigua común repetido; sin común → científico ---
counts = {"colibrí silfo": 1, "mirla": 2}
ave = {"group": "ave", "common_name": "Colibrí silfo", "scientific_name": "Aglaiocercus kingii"}
assert clf.common_dirname(ave, counts) == "colibri-silfo"
dup = {"group": "ave", "common_name": "Mirla", "scientific_name": "Turdus fuscater"}
assert clf.common_dirname(dup, counts) == "mirla__turdus-fuscater"
sinc = {"group": "ave", "common_name": "", "scientific_name": "Turdus fuscater"}
assert clf.common_dirname(sinc, counts) == "turdus-fuscater"

# --- confirm_species: concuerda grupo + umbral + margen (anti-falso-positivo) ---
by_sci = {"aglaiocercus kingii": ave}
sp, sc = clf.confirm_species("ave", [("Aglaiocercus kingii", 0.95), ("x", 0.10)], by_sci)
assert sp is ave and sc == 0.95
sp2, _ = clf.confirm_species("ave", [("Aglaiocercus kingii", 0.20), ("x", 0.05)], by_sci)   # bajo umbral
assert sp2 is None
sp3, _ = clf.confirm_species("anfibio", [("Aglaiocercus kingii", 0.99), ("x", 0.0)], by_sci)  # grupo ≠
assert sp3 is None

# --- id_local.decide_category: umbral por categoría + margen + exclusión ---
assert id_local.decide_category([("ave", 0.95), ("mamifero", 0.02)])[0] == "ave"
assert id_local.decide_category([("ave", 0.80), ("mamifero", 0.02)])[0] is None       # 0.80 < 0.92
assert id_local.decide_category([("paisaje", 0.90), ("aguas", 0.85)])[0] is None      # margen 0.05
assert id_local.decide_category([("infraestructura", 0.99), ("x", 0.0)])[0] is None   # excluida
assert id_local.decide_category([("aguas", 0.90), ("paisaje", 0.05)])[0] == "aguas"   # thr 0.85 ok

# --- id_local.decide_video: mayoría de frames coincide, sin empate ---
def fr(label, p):
    return [(label, p), ("x", 0.0)]
assert id_local.decide_video([fr("paisaje", 0.95), fr("paisaje", 0.98), fr("ave", 0.30)])[0] == "paisaje"
assert id_local.decide_video([fr("paisaje", 0.95), fr("visitante", 0.95), fr("ave", 0.30)])[0] is None  # empate
assert id_local.decide_video([])[0] is None                                            # sin frames

print("test_classify OK")
