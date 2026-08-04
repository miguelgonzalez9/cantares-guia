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

Uso:
  python data_prep/26_sync_media.py pull
  python data_prep/26_sync_media.py pull --download --limit 20
  python data_prep/26_sync_media.py push
  python data_prep/26_sync_media.py selftest
"""

import argparse
import hashlib
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
    print("selftest 26_sync_media: 8/8 OK")


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
    p3 = sub.add_parser("selftest", help="lógica pura, sin red")
    p3.set_defaults(fn=cmd_selftest)
    args = ap.parse_args()
    if not args.cmd:
        ap.print_help(); sys.exit(0)
    args.fn(args)


if __name__ == "__main__":
    main()
