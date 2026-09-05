#!/usr/bin/env python3
"""
26_sync_media.py — Sincroniza el inventario de fotos en los DOS sentidos entre el
archivo local y Supabase, sin duplicar y sin perder la procedencia.

Hasta ahora sólo iba en un sentido (23_catalog_to_media.py promueve del archivo a
la app) y nada volvía. Lo que la app produce —fotos del juego, aportes de
visitantes, subidas del admin— vivía sólo en la nube.

**`content_hash` es lo que hace posible los dos sentidos.** Es la identidad del
CONTENIDO (sha256 del archivo), no de la fila: sin ella, cada pasada vuelve a
subir lo que ya está y a bajar lo que ya se tenía. Por eso `pull` calcula hashes
locales una vez y los cachea.

Comandos:
  pull              lee la tabla `media` y la contrasta con el archivo local.
                    SÓLO METADATOS: no descarga ni un byte de imagen.
  pull --download   además baja los archivos que sólo existen en la nube, a
                    `fotos/_desde_app/<origen>/`. Explícito a propósito.
  push              entradas locales con especie o punto que aún no están en la
                    nube → manifiesto; `--apply` las sube.
  push --rollback   borra de la nube exactamente lo que este script subió
                    (`origin = 'local-archive'`), y nada más.
  decisions         trae las DECISIONES que tomaste EN LA APP: una foto
                    reasignada a otra especie (se mueve a su carpeta y se
                    actualiza el catálogo, con `reason="app"`) y una foto
                    borrada (sale de media.json, del disco y de species.photo).
                    Sin `--apply` sólo escribe el manifiesto.

Uso:
  python data_prep/26_sync_media.py pull
  python data_prep/26_sync_media.py pull --download --limit 20
  python data_prep/26_sync_media.py push
  python data_prep/26_sync_media.py selftest
"""

import argparse
import datetime
import hashlib
import importlib.util
import shutil
import json
import re
import sys
import urllib.request
from collections import Counter
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CANTARES = ROOT.parent
WORK = HERE / "_archive_work"
CATALOG = WORK / "catalog_fotos-reserva-cantares.json"
CLOUD_CATALOG = WORK / "catalog_cloud.json"
HASH_CACHE = WORK / "hash_cache.json"
PUSH_MANIFEST = WORK / "sync_push_manifest.json"
DEC_MANIFEST = WORK / "sync_decisions_manifest.json"
FOTOS = CANTARES / "fotos"
FOTOS_CATALOG = FOTOS / "catalog_fotos.json"
SPECIES_JSON = ROOT / "app" / "public" / "data" / "species.json"
MEDIA_JSON = ROOT / "app" / "public" / "data" / "media.json"
PUBLIC = ROOT / "app" / "public"
DOWNLOAD_DIR = CANTARES / "fotos" / "_desde_app"
CLOUD_JS = ROOT / "app" / "public" / "js" / "cloud.js"

LOCAL_ORIGIN = "local-archive"
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}


# ------------------------------------------------------------------ puras
def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


def diff_by_hash(local, cloud):
    """Compara dos inventarios por hash de contenido.

    `local` = {hash: registro}, `cloud` = {hash: fila}. Devuelve
    (sólo_local, sólo_nube, en_ambos). Las filas de nube SIN hash no se pueden
    emparejar: se devuelven aparte en vez de tratarlas como nuevas, porque
    asumir que son nuevas las volvería a bajar en cada pasada."""
    lh, ch = set(local), set(cloud)
    return sorted(lh - ch), sorted(ch - lh), sorted(lh & ch)


def safe_name(url, fallback="foto"):
    """Nombre de archivo a partir de una URL de Storage, sin permitir que un
    nombre remoto escape del directorio de destino (`../../etc`)."""
    base = url.split("?")[0].rstrip("/").split("/")[-1] or fallback
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    return base[:120] or fallback


# ------------------------------------------------------------------ nube
def cloud_config():
    """URL y anon key desde cloud.js. La anon key es pública por diseño (protegen
    las políticas RLS) y `media` tiene lectura pública, así que basta para leer."""
    src = CLOUD_JS.read_text(encoding="utf-8")
    url = re.search(r"url:\s*'([^']+)'", src).group(1)
    key = re.search(r"eyJ[A-Za-z0-9._-]+", src).group(0)
    return url, key


def fetch_media(url, key):
    req = urllib.request.Request(f"{url}/rest/v1/media?select=*",
                                 headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


# ------------------------------------------------------------------ comandos
def local_hashes(items, base, limit=None):
    """{hash: entrada} del archivo local. Cachea por (ruta, mtime, tamaño): el
    archivo tiene miles de fotos y volver a hashearlas en cada pasada es minutos
    tirados. La clave incluye mtime para que editar una foto invalide su hash."""
    cache = json.loads(HASH_CACHE.read_text(encoding="utf-8")) if HASH_CACHE.exists() else {}
    out, n, fresh = {}, 0, 0
    for it in items:
        if it.get("kind") == "video":
            continue
        src = base / it["file"]
        if src.suffix.lower() not in IMG_EXT or not src.exists():
            continue
        st = src.stat()
        ck = f'{it["file"]}|{int(st.st_mtime)}|{st.st_size}'
        h = cache.get(ck)
        if not h:
            h = sha256_file(src); cache[ck] = h; fresh += 1
        out[h] = it
        n += 1
        if limit and n >= limit:
            break
        if fresh and fresh % 300 == 0:
            HASH_CACHE.write_text(json.dumps(cache), encoding="utf-8"); print(f"  hashes {n}…", flush=True)
    HASH_CACHE.write_text(json.dumps(cache), encoding="utf-8")
    print(f"  {n} fotos locales ({fresh} hasheadas de nuevo, el resto en caché)")
    return out


def cmd_pull(args):
    url, key = cloud_config()
    rows = fetch_media(url, key)
    print(f"nube: {len(rows)} filas en `media`")
    by_origin = Counter(r.get("origin") or "sin origen" for r in rows)
    for o, n in by_origin.most_common():
        print(f"    {o:16s} {n}")

    doc = json.loads(CATALOG.read_text(encoding="utf-8"))
    print("\nhasheando el archivo local…")
    local = local_hashes(doc["items"], Path(doc["base"]), args.limit)

    cloud = {r["content_hash"]: r for r in rows if r.get("content_hash")}
    no_hash = [r for r in rows if not r.get("content_hash")]
    only_local, only_cloud, both = diff_by_hash(local, cloud)

    print(f"\n{'='*58}")
    print(f"  sólo en la nube      {len(only_cloud)}")
    print(f"  sólo en el archivo   {len(only_local)}")
    print(f"  en ambos             {len(both)}")
    print(f"  filas sin hash       {len(no_hash)}  (no emparejables todavía)")

    CLOUD_CATALOG.write_text(json.dumps(
        {"n": len(rows), "only_cloud": [cloud[h] for h in only_cloud],
         "no_hash": no_hash, "matched": len(both)}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n✓ inventario de la nube → {CLOUD_CATALOG}")

    if no_hash:
        print("\nNota: las filas sin `content_hash` son las que subió la app antes")
        print("de que este script existiera. No se pueden emparejar por contenido;")
        print("se listan aparte en vez de darlas por nuevas, que las bajaría en")
        print("cada pasada. Se resuelven bajándolas una vez con --download.")

    if not args.download:
        print("\n(sólo metadatos — usa --download para traer los archivos)")
        return

    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    todo = [cloud[h] for h in only_cloud] + no_hash
    todo = todo[: args.limit] if args.limit else todo
    print(f"\nbajando {len(todo)} archivo(s) a {DOWNLOAD_DIR}…")
    got = 0
    for r in todo:
        if not r.get("url"):
            continue
        # La carpeta ES la procedencia, igual que la carpeta es la categoría en
        # el resto del archivo. Así se ve de un vistazo qué vino de la app.
        d = DOWNLOAD_DIR / (r.get("origin") or "sin-origen")
        d.mkdir(parents=True, exist_ok=True)
        dst = d / safe_name(r["url"])
        if dst.exists():
            continue
        try:
            with urllib.request.urlopen(r["url"], timeout=90) as resp, open(dst, "wb") as f:
                f.write(resp.read())
            got += 1
            print(f"  ✓ {dst.name}")
        except Exception as e:
            print(f"  ✗ {r.get('id')}: {type(e).__name__}")
    print(f"\n✓ {got} archivo(s) nuevos. NO se movió ni se borró nada del archivo.")


def cmd_push(args):
    url, key = cloud_config()
    rows = fetch_media(url, key)

    if args.rollback:
        mine = [r for r in rows if r.get("origin") == LOCAL_ORIGIN]
        print(f"{len(mine)} fila(s) con origin='{LOCAL_ORIGIN}' en la nube.")
        print("Borrarlas requiere sesión de admin (RLS). Este script sólo lee.")
        print("Hazlo desde la app (bandeja de Fotos) o con el SQL Editor:")
        print(f"    delete from public.media where origin = '{LOCAL_ORIGIN}';")
        return

    doc = json.loads(CATALOG.read_text(encoding="utf-8"))
    items, base = doc["items"], Path(doc["base"])
    cloud_hashes = {r["content_hash"] for r in rows if r.get("content_hash")}

    print("hasheando el archivo local…")
    local = local_hashes(items, base, args.limit)

    # Candidatas: lo que tiene ESPECIE o PUNTO (algo que aporta al inventario) y
    # aún no está en la nube. Una foto sin ninguna de las dos no aporta nada a
    # una galería, así que subirla sólo gasta almacenamiento.
    cand = []
    for h, it in local.items():
        if h in cloud_hashes:
            continue
        if not (it.get("scientific_name") or it.get("punto")):
            continue
        cand.append({"content_hash": h, "file": it["file"],
                     "scientific_name": it.get("scientific_name"),
                     "punto": it.get("punto"), "category": it.get("category")})

    PUSH_MANIFEST.write_text(json.dumps({"n": len(cand), "results": cand},
                                        ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n  candidatas a subir: {len(cand)}")
    print(f"    con especie: {sum(1 for c in cand if c['scientific_name'])}")
    print(f"    con punto:   {sum(1 for c in cand if c['punto'])}")
    print(f"\n✓ manifiesto → {PUSH_MANIFEST}")
    print("\nLa subida en sí la hace 23_catalog_to_media.py --apply, que ya optimiza")
    print("a WebP y escribe media.json. Este script decide QUÉ falta; aquel, cómo.")


# ---------------------------------------------- decisiones de la app -> local
# Hasta aqui la sincronizacion movia ARCHIVOS. Esto mueve DECISIONES, que es lo
# que de verdad se perdia: cuando arreglas en la app una foto que quedo en la
# especie equivocada, esa es una etiqueta puesta por una persona — justo el
# material con el que 32_build_prototypes entrena — y el catalogo local nunca se
# enteraba. Y cuando borrabas una foto, el fichero seguia en el repo.
#
# Las dos decisiones que viajan:
#   REASIGNAR  fila de la nube con subject_type='species' cuyo content_hash casa
#              con una foto local que el catalogo tiene en OTRA especie.
#   BORRAR     lapida (status='deleted'). Si su id es una ruta del build
#              ('img/species/...') hay que sacarla de media.json y del disco; si
#              es 'sp-photo:<id>', hay que vaciar species.photo.
#
# No destructivo por defecto: manifiesto, y solo con --apply se toca algo.

def load_mod14():
    """`common_dirname`/`species_folder` de 14_classify_photos, importadas y no
    copiadas: son las que deciden en que carpeta vive cada especie, y dos copias
    que se separen parten el archivo en carpetas gemelas."""
    spec = importlib.util.spec_from_file_location("mod14", HERE / "14_classify_photos.py")
    m = importlib.util.module_from_spec(spec)
    sys.modules["mod14"] = m
    spec.loader.exec_module(m)
    return m


def build_paths(mid):
    """Ficheros del build que representan una foto empacada, a partir del id de
    su lapida (que ES su ruta). Devuelve los tres: webp, jpg y miniatura."""
    stem = re.sub(r"\.(webp|jpe?g|png)$", "", str(mid or ""), flags=re.I)
    if not stem.startswith("img/"):
        return []
    name = stem.split("/")[-1]
    return [stem + ".webp", stem + ".jpg", "img/_thumbs/" + name + ".webp"]


def plan_decisions(cloud_rows, local_by_hash, sci_by_species_id, media_files, species_photo):
    """Decide, sin tocar disco ni red, que hay que aplicar en local.

    `local_by_hash`      {content_hash: entrada del catalogo de fotos/}
    `sci_by_species_id`  {id de especie: nombre cientifico} (de species.json)
    `media_files`        rutas del build presentes en media.json
    `species_photo`      {id de especie: su campo photo}
    """
    reasign, borrar_build, limpiar_photo, sin_efecto = [], [], [], 0
    for r in cloud_rows:
        rid = str(r.get("id") or "")
        if r.get("status") == "deleted":
            if rid.startswith("sp-photo:"):
                sid = rid.split(":", 1)[1]
                if species_photo.get(sid):
                    limpiar_photo.append({"species_id": sid, "photo": species_photo[sid]})
                else:
                    sin_efecto += 1
            elif rid.startswith("img/"):
                paths = build_paths(rid)
                if rid in media_files or any(f in media_files for f in paths):
                    borrar_build.append({"id": rid, "files": paths})
                else:
                    sin_efecto += 1
            else:
                sin_efecto += 1          # fila de la nube: ya se borro donde vivia
            continue
        h = r.get("content_hash")
        sid = r.get("subject_id")
        if r.get("subject_type") != "species" or not h or not sid:
            continue
        it = local_by_hash.get(h)
        if not it:
            continue                     # la foto no esta en el archivo local
        sci_app = sci_by_species_id.get(sid)
        if not sci_app:
            continue                     # especie que solo existe en la nube
        if (it.get("scientific_name") or "").strip().lower() == sci_app.strip().lower():
            continue                     # ya coinciden: nada que hacer
        reasign.append({"hash": h, "file": it.get("file"),
                        "de": it.get("scientific_name"), "a": sci_app,
                        "species_id": sid})
    return reasign, borrar_build, limpiar_photo, sin_efecto


def cmd_decisions(args):
    url, key = cloud_config()
    rows = fetch_media(url, key)
    print("nube: %d filas en `media`" % len(rows))

    cat = json.loads(FOTOS_CATALOG.read_text(encoding="utf-8")) if FOTOS_CATALOG.exists() else {"photos": []}
    local_by_hash = {p["hash"]: p for p in cat["photos"] if p.get("hash")}
    print("catalogo local de fotos/: %d con hash" % len(local_by_hash))

    spdoc = json.loads(SPECIES_JSON.read_text(encoding="utf-8"))
    sci_by_id = {s["id"]: s.get("scientific_name") for s in spdoc["species"] if s.get("scientific_name")}
    species_photo = {s["id"]: s.get("photo") for s in spdoc["species"] if s.get("photo")}

    mdoc = json.loads(MEDIA_JSON.read_text(encoding="utf-8"))
    media_files = set()
    for ph in mdoc["photos"]:
        for k in ("file", "jpg", "thumb"):
            if ph.get(k):
                media_files.add(ph[k])

    reasign, borrar, limpiar, sin_efecto = plan_decisions(
        rows, local_by_hash, sci_by_id, media_files, species_photo)

    print("\n" + "=" * 58)
    print("  reasignaciones de especie   %d" % len(reasign))
    print("  fotos del build a borrar    %d" % len(borrar))
    print("  species.photo a vaciar      %d" % len(limpiar))
    print("  lapidas sin efecto local    %d" % sin_efecto)
    for x in reasign[:12]:
        print("    ~ %s\n        %s  ->  %s" % (x["file"], x["de"], x["a"]))
    for x in borrar[:12]:
        print("    - %s" % x["id"])
    for x in limpiar[:12]:
        print("    - species.photo de %s  (%s)" % (x["species_id"], x["photo"]))

    DEC_MANIFEST.write_text(json.dumps(
        {"generado": datetime.datetime.now().isoformat(timespec="seconds"),
         "reasignar": reasign, "borrar_build": borrar, "limpiar_photo": limpiar},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n[ok] manifiesto -> %s" % DEC_MANIFEST)

    if not args.apply:
        print("\n(nada tocado - vuelve a correrlo con --apply)")
        return
    if not (reasign or borrar or limpiar):
        print("\nnada que aplicar.")
        return

    mod14 = load_mod14()
    counts = {}
    for s in spdoc["species"]:
        c = (s.get("common_name") or "").strip()
        if c:
            k = mod14.slug(c)
            counts[k] = counts.get(k, 0) + 1
    by_id = {s["id"]: s for s in spdoc["species"]}

    # --- 1. reasignar: MOVER el fichero y actualizar el catalogo -------------
    # Mover no es opcional. La carpeta es la etiqueta humana y 30_species_folders
    # la lee como verdad: si solo se tocara el catalogo, la siguiente pasada de 30
    # volveria a ponerle la especie de la carpeta y desharia esto.
    movidas = 0
    for x in reasign:
        rec = by_id.get(x["species_id"])
        it = local_by_hash.get(x["hash"])
        if not rec or not it:
            continue
        src = CANTARES / it["file"]
        if not src.exists():
            print("    ! no esta en disco: %s" % it["file"])
            continue
        dst_dir = FOTOS / mod14.species_folder(rec) / mod14.common_dirname(rec, counts)
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / src.name
        if dst.exists() and dst.resolve() != src.resolve():
            dst = dst_dir / (src.stem + "_" + x["hash"][:8] + src.suffix)
        if src.resolve() != dst.resolve():
            shutil.move(str(src), str(dst))
        it["file"] = str(dst.relative_to(CANTARES)).replace("\\", "/")
        it["species_id"] = x["species_id"]
        it["scientific_name"] = x["a"]
        it["category"] = mod14.species_folder(rec)
        it["reason"] = "app"              # decidido por una persona EN LA APP
        movidas += 1
    if movidas:
        bak = FOTOS_CATALOG.with_suffix(".json.bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
        shutil.copy2(FOTOS_CATALOG, bak)
        FOTOS_CATALOG.write_text(json.dumps(cat, ensure_ascii=False, indent=1), encoding="utf-8")
        print("\n  %d foto(s) movidas + catalogo actualizado (copia: %s)" % (movidas, bak.name))

    # --- 2. borrar del build -------------------------------------------------
    # Los ficheros estan en git: si te arrepientes, `git checkout -- <ruta>`.
    if borrar:
        fuera = set()
        for x in borrar:
            fuera.update(x["files"])
            fuera.add(x["id"])
        antes = len(mdoc["photos"])
        mdoc["photos"] = [ph for ph in mdoc["photos"]
                          if not any(ph.get(k) in fuera for k in ("file", "jpg", "thumb"))]
        quitadas = antes - len(mdoc["photos"])
        borradas = 0
        for rel in sorted(fuera):
            f = PUBLIC / rel
            if f.exists():
                f.unlink()
                borradas += 1
        MEDIA_JSON.write_text(json.dumps(mdoc, ensure_ascii=False, indent=1), encoding="utf-8")
        print("  %d entrada(s) fuera de media.json, %d fichero(s) borrados" % (quitadas, borradas))

    # --- 3. vaciar species.photo --------------------------------------------
    if limpiar:
        for x in limpiar:
            s = by_id.get(x["species_id"])
            if s:
                s["photo"] = None
        bak = SPECIES_JSON.with_suffix(".json.bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
        shutil.copy2(SPECIES_JSON, bak)
        SPECIES_JSON.write_text(json.dumps(spdoc, ensure_ascii=False, indent=2), encoding="utf-8")
        print("  %d species.photo vaciado(s) (copia: %s)" % (len(limpiar), bak.name))

    print("\nSi borraste fotos del build, sube VERSION en sw.js y despliega.")


def cmd_selftest(args):
    a = {"h1": {"file": "a.jpg"}, "h2": {"file": "b.jpg"}}
    c = {"h2": {"id": "x"}, "h3": {"id": "y"}}
    only_l, only_c, both = diff_by_hash(a, c)
    assert only_l == ["h1"] and only_c == ["h3"] and both == ["h2"], (only_l, only_c, both)
    # Inventarios idénticos → nada que hacer. Es la condición de idempotencia:
    # una segunda pasada no debe proponer trabajo.
    assert diff_by_hash(a, a) == ([], [], ["h1", "h2"])
    assert diff_by_hash({}, {}) == ([], [], [])

    # Un nombre remoto no puede escaparse del directorio de destino.
    assert safe_name("https://x/storage/v1/object/public/media/foto_1.jpg") == "foto_1.jpg"
    assert "/" not in safe_name("https://x/../../etc/passwd")
    # Lo que importa no es el nombre exacto sino que NUNCA salga del destino:
    # sin separadores de ruta y siempre no vacío.
    for u in ("https://x/../../etc/passwd", "https://x/%2e%2e%2fevil.jpg",
              "https://x/", "https://x/a b/c:d?token=1"):
        n = safe_name(u)
        assert n and "/" not in n and "\\" not in n and ":" not in n, (u, n)

    import tempfile
    with tempfile.NamedTemporaryFile(delete=False) as f:
        f.write(b"cantares"); p = f.name
    # sha256("cantares") — el hash es del CONTENIDO, no de la ruta: la misma
    # foto en dos carpetas es una sola foto.
    assert sha256_file(p) == hashlib.sha256(b"cantares").hexdigest()
    Path(p).unlink()
    # ---- decisiones de la app (plan_decisions / build_paths) ----
    # Del id de una lapida salen los TRES ficheros del build, no solo el que se
    # nombra: media.json guarda webp + jpg + miniatura y dejar una suelta seria
    # una entrada rota o un fichero huerfano en el repo.
    assert build_paths("img/species/copeton__1.webp") == [
        "img/species/copeton__1.webp", "img/species/copeton__1.jpg",
        "img/_thumbs/copeton__1.webp"]
    assert build_paths("img/species/copeton__1.jpg")[0] == "img/species/copeton__1.webp"
    assert build_paths("gm-123") == []           # fila de la nube, no del build
    assert build_paths(None) == []

    loc = {"h1": {"file": "fotos/aves/mirla/x.jpg", "scientific_name": "Turdus fuscater"},
           "h2": {"file": "fotos/aves/copeton/y.jpg", "scientific_name": "Zonotrichia capensis"}}
    sci = {"chara-collareja": "Cyanolyca armillata", "copeton": "Zonotrichia capensis"}
    mfiles = {"img/species/copeton__1.webp"}
    sphoto = {"guatin": "img/species/guatin__1.webp"}

    # 1. reasignada en la app: el catalogo dice Turdus, la app dice Cyanolyca
    r, b, l, ne = plan_decisions(
        [{"id": "z", "subject_type": "species", "subject_id": "chara-collareja",
          "content_hash": "h1"}], loc, sci, mfiles, sphoto)
    assert len(r) == 1 and r[0]["de"] == "Turdus fuscater" and r[0]["a"] == "Cyanolyca armillata"

    # 2. la que YA coincide no genera trabajo: es la condicion de idempotencia,
    #    una segunda pasada tras aplicar no debe proponer nada.
    r2, _, _, _ = plan_decisions(
        [{"id": "z", "subject_type": "species", "subject_id": "copeton",
          "content_hash": "h2"}], loc, sci, mfiles, sphoto)
    assert r2 == []

    # 3. lapida sobre una foto del build -> fuera de media.json y del disco
    _, b3, _, _ = plan_decisions(
        [{"id": "img/species/copeton__1.jpg", "status": "deleted"}], loc, sci, mfiles, sphoto)
    assert len(b3) == 1 and "img/_thumbs/copeton__1.webp" in b3[0]["files"]

    # 4. lapida sobre species.photo -> vaciar el campo
    _, _, l4, _ = plan_decisions(
        [{"id": "sp-photo:guatin", "status": "deleted"}], loc, sci, mfiles, sphoto)
    assert l4 == [{"species_id": "guatin", "photo": "img/species/guatin__1.webp"}]

    # 5. lapida de una fila normal de la nube: no hay nada local que tocar. Se
    #    cuenta aparte en vez de callarla, o cada pasada pareceria no ver nada.
    _, b5, l5, ne5 = plan_decisions(
        [{"id": "gm-123", "status": "deleted"}], loc, sci, mfiles, sphoto)
    assert b5 == [] and l5 == [] and ne5 == 1

    # 6. una foto de la nube que NO esta en el archivo local no se inventa
    r6, _, _, _ = plan_decisions(
        [{"id": "z", "subject_type": "species", "subject_id": "copeton",
          "content_hash": "desconocido"}], loc, sci, mfiles, sphoto)
    assert r6 == []

    # 7. especie que solo existe en la nube (creada desde el panel): sin nombre
    #    cientifico local no se puede decidir nada, y adivinar seria peor.
    r7, _, _, _ = plan_decisions(
        [{"id": "z", "subject_type": "species", "subject_id": "sp_mrgumkvr265",
          "content_hash": "h1"}], loc, sci, mfiles, sphoto)
    assert r7 == []

    print("selftest 26_sync_media: 19/19 OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    p1 = sub.add_parser("pull", help="nube → archivo (metadatos; --download trae ficheros)")
    p1.add_argument("--download", action="store_true")
    p1.add_argument("--limit", type=int, default=None)
    p1.set_defaults(fn=cmd_pull)
    p2 = sub.add_parser("push", help="archivo → nube (manifiesto)")
    p2.add_argument("--rollback", action="store_true")
    p2.add_argument("--limit", type=int, default=None)
    p2.set_defaults(fn=cmd_push)
    p4 = sub.add_parser("decisions", help="nube → local: reasignaciones y borrados hechos EN LA APP")
    p4.add_argument("--apply", action="store_true", help="aplicar (por defecto sólo manifiesto)")
    p4.set_defaults(fn=cmd_decisions)
    p3 = sub.add_parser("selftest", help="lógica pura, sin red")
    p3.set_defaults(fn=cmd_selftest)
    args = ap.parse_args()
    if not args.cmd:
        ap.print_help(); sys.exit(0)
    args.fn(args)


if __name__ == "__main__":
    main()
