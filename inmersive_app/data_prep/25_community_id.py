#!/usr/bin/env python3
"""
25_community_id.py — Segunda pasada sobre la flora que el clasificador local dejó
sin clasificar, preguntándole a Pl@ntNet.

El clasificador local se abstiene en el 43% del archivo. Buena parte de esa cola
son plantas que CLIP reconoció como flora pero por debajo del umbral, o que
BioCLIP no pudo resolver a especie. Pl@ntNet está entrenado justo para eso.

Mismo criterio que la Edge Function `identify` (inmersive_app/supabase/functions/
identify) y
que id_local: **antes sin clasificar que mal clasificado**.

  1. Candidatos: entradas `_sin_clasificar` cuyo CLIP top-1 sea flora
     (planta / flor / arbol). Lo demás no se le pregunta a Pl@ntNet — es un
     identificador de plantas y con un ave devuelve ruido con score bajo.
  2. Pl@ntNet propone especies del mundo entero (~50.000).
  3. GUARDIA DE CONJUNTO CERRADO: sólo se acepta si la especie está en
     species.json. Una propuesta de fuera NO se asigna, pero se registra como
     posible hallazgo — es información para el inventario, no basura.
  4. Umbral + margen contra el segundo candidato DEL INVENTARIO.

Cuota: 500 identificaciones/día en el plan gratis, compartidas con la app. Por
eso `--max-seconds` y `--limit`, y por eso es reanudable: se puede correr en
tandas cortas durante varios días sin repetir trabajo ni gastar cuota de más.

Uso:
  python data_prep/25_community_id.py --limit 10            # manifiesto (no escribe el catálogo)
  python data_prep/25_community_id.py --limit 200 --max-seconds 600
  python data_prep/25_community_id.py --apply               # escribe en el catálogo
  python data_prep/25_community_id.py --rollback            # deshace exactamente lo suyo

Requiere PLANTNET_API_KEY en data_prep/.env (local, gitignored).
"""

import argparse
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WORK = HERE / "_archive_work"
CATALOG = WORK / "catalog_fotos-reserva-cantares.json"
SPECIES_JSON = ROOT / "app" / "public" / "data" / "species.json"
MANIFEST = WORK / "community_id_manifest.json"
STATE = WORK / "community_id_state.json"     # reanudable: claves ya preguntadas

PLANTNET = "https://my-api.plantnet.org/v2/identify/all"
FLORA = {"planta", "flor", "arbol"}
SCORE_MIN = 0.40        # mismos valores que ../supabase/functions/identify/index.ts
MARGIN_MIN = 0.10
SOURCE_TAG = "plantnet"  # marca de procedencia → rollback exacto
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}


# ------------------------------------------------------------------ puras
def norm_sci(s):
    """Nombre científico comparable: sin acentos, sin autor, minúsculas."""
    import unicodedata
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join(s.lower().split())


def decide(candidates, inventory):
    """Espejo exacto de `decide()` en la Edge Function. Devuelve (veredicto, dato).

    `candidates` = [(sci, common, score)] ordenados desc. `inventory` = {sci_norm: id}.
    El margen se mide contra el segundo DEL INVENTARIO: que Pl@ntNet dude entre dos
    especies que aquí no existen no debe restarle confianza a la única que sí."""
    if not candidates:
        return "abstain", {"reason": "sin candidatos"}
    ranked = [(sci, com, sc, inventory.get(norm_sci(sci))) for sci, com, sc in candidates]
    in_house = [r for r in ranked if r[3]]
    if not in_house:
        # Un candidato de fuera del inventario sólo es un HALLAZGO si Pl@ntNet
        # está seguro. Con score 0.03 no está diciendo «hay una especie nueva»,
        # está diciendo «no sé»: reportarlo como hallazgo hace perder el tiempo
        # revisando ruido y devalúa los avisos que sí importan.
        if ranked[0][2] < SCORE_MIN:
            return "abstain", {"reason": f"score bajo ({ranked[0][2]:.2f} < {SCORE_MIN}), "
                                         f"nada del inventario"}
        return "outside-inventory", {"reason": f"«{ranked[0][0]}» no está en el inventario",
                                     "top_sci": ranked[0][0], "top_score": ranked[0][2]}
    sci, com, score, sid = in_house[0]
    second = in_house[1][2] if len(in_house) > 1 else 0.0
    if score < SCORE_MIN:
        return "abstain", {"reason": f"score bajo ({score:.2f} < {SCORE_MIN})"}
    if score - second < MARGIN_MIN:
        return "abstain", {"reason": f"margen bajo ({score:.2f} vs {second:.2f})"}
    return "ok", {"species_id": sid, "scientific_name": sci, "common": com, "score": score}


# ------------------------------------------------------------------ E/S
def load_env():
    env = HERE / ".env"
    if not env.exists():
        sys.exit("Falta data_prep/.env (copia .env.example y pon tu clave).")
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("PLANTNET_API_KEY="):
            key = line.split("=", 1)[1].strip().strip('"').strip("'")
            if key:
                return key
    sys.exit("PLANTNET_API_KEY vacía en data_prep/.env — consíguela gratis en my.plantnet.org.")


def load_inventory():
    doc = json.loads(SPECIES_JSON.read_text(encoding="utf-8"))
    inv = {}
    for s in doc.get("species", []):
        sci = (s.get("scientific_name") or "").strip()
        if sci:
            inv.setdefault(norm_sci(sci), s["id"])
    return inv


def ask_plantnet(path, key, lang="es"):
    """Una identificación. Devuelve (candidatos, error). Nunca lanza: un fallo de
    identificación es normal y no debe tumbar un lote de doscientas fotos."""
    import urllib.error
    import urllib.request
    import uuid
    boundary = uuid.uuid4().hex
    data = path.read_bytes()
    body = b"".join([
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"organs\"\r\n\r\nauto\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"images\"; "
        f"filename=\"photo.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".encode(),
        data, b"\r\n", f"--{boundary}--\r\n".encode(),
    ])
    url = f"{PLANTNET}?api-key={key}&lang={lang}"
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            js = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return None, "quota"          # cuota diaria agotada → parar el lote
        return None, f"http {e.code}"
    except Exception as e:
        return None, f"{type(e).__name__}"
    return [(r.get("species", {}).get("scientificNameWithoutAuthor", ""),
             (r.get("species", {}).get("commonNames") or [None])[0] or "",
             r.get("score", 0.0))
            for r in js.get("results", [])[:8]
            if r.get("species", {}).get("scientificNameWithoutAuthor")], None


# ------------------------------------------------------------------ principal
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=50, help="máximo de fotos a preguntar")
    ap.add_argument("--max-seconds", type=int, default=900,
                    help="presupuesto de tiempo; el portátil se duerme y mata los procesos largos")
    ap.add_argument("--apply", action="store_true", help="escribe el resultado en el catálogo")
    ap.add_argument("--rollback", action="store_true", help="deshace exactamente lo que este script escribió")
    ap.add_argument("--lang", default="es")
    args = ap.parse_args()

    doc = json.loads(CATALOG.read_text(encoding="utf-8"))
    items, base = doc["items"], Path(doc["base"])

    if args.rollback:
        # Sólo lo marcado con SOURCE_TAG: el trabajo del clasificador local y el
        # de Miguel no se toca nunca.
        n = 0
        for it in items:
            if it.get("id_source") == SOURCE_TAG:
                it.pop("id_source", None); it.pop("id_note", None)
                it["scientific_name"] = None
                it["species_checked"] = False
                if it.get("category") == "planta" and it.get("_prev_category"):
                    it["category"] = it.pop("_prev_category")
                n += 1
        CATALOG.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"↩ deshechas {n} identificaciones de {SOURCE_TAG}")
        return

    key = load_env()
    inventory = load_inventory()
    done = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    print(f"inventario: {len(inventory)} nombres científicos · ya preguntadas: {len(done)}")

    # Candidatos: sin clasificar, con pinta de flora según el intento local.
    # El catálogo guarda la razón («baja confianza (planta 0.57 < 0.66)»), que
    # dice qué categoría iba ganando. Preguntarle a Pl@ntNet por un ave gasta
    # cuota para nada: sólo identifica plantas.
    cands = []
    for it in items:
        if it.get("category") != "_sin_clasificar" or it.get("kind") == "video":
            continue
        if it["key"] in done:
            continue
        reason = it.get("reason") or ""
        if not any(f in reason for f in FLORA):
            continue
        if (base / it["file"]).suffix.lower() not in IMG_EXT:
            continue
        cands.append(it)

    print(f"candidatos de flora sin clasificar: {len(cands)} "
          f"(se preguntarán {min(len(cands), args.limit)})\n")
    if not cands:
        print("nada que preguntar."); return

    t0, results, counts = time.time(), [], Counter()
    for n, it in enumerate(cands[: args.limit]):
        if time.time() - t0 > args.max_seconds:
            print(f"\n⏱ presupuesto agotado tras {n} — vuelve a correr para seguir")
            break
        src = base / it["file"]
        if not src.exists():
            counts["falta el archivo"] += 1; continue
        cand, err = ask_plantnet(src, key, args.lang)
        if err == "quota":
            print("\n⚠ cuota diaria de Pl@ntNet agotada — vuelve mañana"); break
        if err:
            counts[f"error: {err}"] += 1; continue
        verdict, info = decide(cand, inventory)
        counts[verdict] += 1
        done[it["key"]] = verdict
        results.append({"key": it["key"], "file": it["file"], "verdict": verdict, **info})
        print(f"  {n+1:>4}/{min(len(cands), args.limit)} {verdict:18s} {it['file'][-52:]}")
        time.sleep(1.0)   # cortesía con la API pública

    STATE.write_text(json.dumps(done, ensure_ascii=False), encoding="utf-8")
    MANIFEST.write_text(json.dumps({"n": len(results), "results": results},
                                   ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{'='*60}")
    for k, v in counts.most_common():
        print(f"  {k:24s} {v}")
    print(f"\n✓ manifiesto → {MANIFEST}")

    hallazgos = [r for r in results if r["verdict"] == "outside-inventory"]
    if hallazgos:
        print(f"\n{len(hallazgos)} posibles HALLAZGOS (especie no listada en la reserva):")
        for r in hallazgos[:10]:
            print(f"    {r.get('top_sci')} ({r.get('top_score', 0):.2f})  {r['file'][-46:]}")
        print("  No se asignan solas. Revísalas: si alguna es real, va al inventario.")

    if not args.apply:
        print("\n(manifiesto solamente — corre con --apply para escribir el catálogo)")
        return

    by_key = {r["key"]: r for r in results if r["verdict"] == "ok"}
    n = 0
    for it in items:
        r = by_key.get(it["key"])
        if not r:
            continue
        it["_prev_category"] = it.get("category")
        it["category"] = "planta"
        it["scientific_name"] = r["scientific_name"]
        it["species_checked"] = True
        it["confidence"] = round(r["score"], 3)
        it["id_source"] = SOURCE_TAG
        it["id_note"] = f"Pl@ntNet {r['score']:.2f} → {r['scientific_name']}"
        n += 1
    CATALOG.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n✓ {n} entradas identificadas y escritas (deshaz con --rollback)")


def selftest():
    """La lógica de decisión, sin red ni clave."""
    inv = {"panopsis suaveolens": "panopsis-suaveolens", "cedrela montana": "cedrela-montana"}
    v, d = decide([("Panopsis suaveolens", "Yolombo", 0.91)], inv)
    assert v == "ok" and d["species_id"] == "panopsis-suaveolens", (v, d)
    # LA guardia: lo que no está en la reserva nunca se asigna.
    v, _ = decide([("Monstera deliciosa", "", 0.97)], inv)
    assert v == "outside-inventory", v
    # Dos especies de la reserva empatadas → abstenerse.
    v, _ = decide([("Panopsis suaveolens", "", 0.52), ("Cedrela montana", "", 0.48)], inv)
    assert v == "abstain", v
    # El 2º de FUERA no debe provocar abstención.
    v, _ = decide([("Panopsis suaveolens", "", 0.45), ("Quercus robur", "", 0.44)], inv)
    assert v == "ok", v
    v, _ = decide([("Panopsis suaveolens", "", 0.31)], inv)
    assert v == "abstain", v
    assert decide([], inv)[0] == "abstain"
    # Fuera del inventario con score ínfimo NO es un hallazgo: es «no sé».
    # Medido en vivo: Euphorbia a 0.03 se reportaba como posible hallazgo.
    v, _ = decide([("Euphorbia leucocephala", "", 0.03)], inv)
    assert v == "abstain", v
    # Pero uno de fuera CON confianza sí merece que un humano lo mire.
    v, _ = decide([("Monstera deliciosa", "", 0.88)], inv)
    assert v == "outside-inventory", v
    assert norm_sci("  Panópsis   SUAVEOLENS ") == "panopsis suaveolens"
    print("selftest 25_community_id: 9/9 OK")


if __name__ == "__main__":
    if "selftest" in sys.argv:
        selftest()
    else:
        main()
