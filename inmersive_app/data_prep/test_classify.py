"""Checks mínimos de la lógica de decisión/carpetas (sin modelos ni red)."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("clf", Path(__file__).parent / "14_classify_photos.py")
clf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clf)

# --- carpeta = común, id = científico; desambigua común repetido ---
counts = {"colibrí silfo": 1, "mirla": 2}
ave = {"group": "ave", "common_name": "Colibrí silfo", "scientific_name": "Aglaiocercus kingii"}
assert clf.common_dirname(ave, counts) == "colibri-silfo"
dup = {"group": "ave", "common_name": "Mirla", "scientific_name": "Turdus fuscater"}
assert clf.common_dirname(dup, counts) == "mirla__turdus-fuscater"          # común repetido → +científico
sinc = {"group": "ave", "common_name": "", "scientific_name": "Turdus fuscater"}
assert clf.common_dirname(sinc, counts) == "turdus-fuscater"                # sin común → científico

# --- decide(): guardia de acuerdo CLIP↔motor + umbral por motor ---
by_sci = {"aglaiocercus kingii": ave}
# ave con vista casi segura, concuerda grupo → confirma, razón nombra el motor
folder, sp, sc, why = clf.decide("ave", 0.9, [("Aglaiocercus kingii", 0.95), ("x", 0.10)],
                                 by_sci, clf.INAT_MIN, "iNat")
assert sp is ave and folder == "aves" and "iNat" in why, (folder, sp, why)
# ave por debajo del umbral iNat → incierta (no inventa especie)
_, sp2, _, why2 = clf.decide("ave", 0.9, [("Aglaiocercus kingii", 0.60), ("x", 0.10)],
                             by_sci, clf.INAT_MIN, "iNat")
assert sp2 is None and "incierta" in why2
# CLIP dice anfibio pero el motor devuelve un ave → NO concuerda → sin especie (anti-falso-positivo)
_, sp3, _, _ = clf.decide("anfibio", 0.9, [("Aglaiocercus kingii", 0.99), ("x", 0.0)],
                          by_sci, clf.SPECIES_MIN, "BioCLIP")
assert sp3 is None

print("test_classify OK")
