#!/usr/bin/env python3
"""
37_reconcile_folders.py — Reconcilia las carpetas de fotos con el inventario.

El problema NO era el que parecia. La revision encontro que **ninguna** de las 744
especies del inventario se ha quedado sin carpeta; lo que hay es lo contrario:
carpetas HUERFANAS, con nombres que ya no corresponden a ninguna especie (erratas,
`snake_case` heredado, nombres genericos, restos de `33_resolve_names --apply` y
`34_merge_duplicates --apply`). Sus fotos son invisibles para el resto del pipeline:
no estan en `catalog_fotos.json`, asi que nunca llegan a `media.json` ni a la app.

Este script las devuelve a su carpeta canonica y las registra en el catalogo.

COMO DECIDE (escalera de evidencia, de mas fuerte a mas debil). Cada movimiento
queda anotado con el peldano que lo decidio, para que se pueda auditar despues:

  catalogo   Todos los archivos catalogados de la carpeta coinciden en una especie.
             Es la evidencia mas fuerte porque no depende del nombre de la carpeta.
  cientifico El nombre de la carpeta es el cientifico de una unica especie.
  comun      Es el nombre comun de una unica especie DEL MISMO GRUPO.
  prefijo    Es prefijo del nombre comun de una unica especie del grupo
             (`ardilla` -> `ardilla-comun`).
  epiteto    Cada palabra de la carpeta casa —exacta, o a un caracter de distancia
             si mide 6+ letras— con una palabra del nombre de una unica especie del
             grupo. Es lo que rescata `pava_goudotti` -> *Chamaepetes goudotii*
             [Pava maraquera], donde la errata esta en el epiteto.

Lo que NO decide se queda quieto y se reporta. Abstenerse es el comportamiento
correcto: `aves/andigena_nigrirostris` se llama como un tucan y el catalogo dice que
sus fotos son de otro (*Aulacorhynchus albivitta*) y de un arbol. Moverlas por el
nombre de la carpeta seria clasificarlas mal, que es peor que no clasificarlas.

Se probo `difflib` como ultimo peldano y se descarto: no alcanzaba `pava_goudotti`
(31 fotos) y en cambio se inventaba `silvo-silvo` -> `silva-silva`, dos plantas
distintas. El peldano de epiteto acierta la primera y no dispara con la segunda.

NUNCA BORRA UN ARCHIVO. Una copia duplicada (mismo hash que una ya presente en el
destino) se aparta a `fotos/_duplicados/` anotando de donde vino. Solo se eliminan
directorios que quedan vacios.

Uso:
    python data_prep/37_reconcile_folders.py              # manifiesto, no toca nada
    python data_prep/37_reconcile_folders.py --apply
    python data_prep/37_reconcile_folders.py --rollback _reconcile_moves-<ts>.json
    python data_prep/37_reconcile_folders.py --selftest   # sin disco ni modelos
"""

import importlib.util
import json
import shutil
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent


# El modulo de clasificacion empieza por digito: no se puede `import`. Se carga por
# ruta para REUTILIZAR sus funciones (slug, common_dirname, species_folder, sha256,
# read_exif) en vez de recopiarlas — si la regla de nombre de carpeta cambia alli,
# este script la hereda en vez de divergir en silencio.
def _load(name):
    spec = importlib.util.spec_from_file_location(name.replace(".py", ""), HERE / name)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------- distancia de edicion (para el peldano de epiteto) ----------
def lev(a, b):
    """Levenshtein. La stdlib no lo trae y difflib.ratio no es distancia de edicion:
    aqui hace falta 'a un caracter', no 'parecido en un %'."""
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def tok_match(t, u):
    """Una palabra casa con otra: igual, o a un caracter si ambas miden 6+.
    El umbral de longitud existe porque a distancia 1 'pava'/'pavo' son palabras
    distintas; en un epiteto de 8 letras, un caracter es una errata."""
    return t == u or (len(t) >= 6 and len(u) >= 6 and lev(t, u) <= 1)


def resolve(dname, grupo, cat_scis, pool, slug, species_folder):
    """(especie | None, peldano). `cat_scis` = cientificos que el catalogo asigna a
    los archivos de esta carpeta; `pool` = registros del inventario."""
    scis = {s for s in cat_scis if s}
    if len(scis) > 1:
        return None, "conflicto:catalogo-discrepa(" + ", ".join(sorted(scis)) + ")"
    by_sci = {s["scientific_name"].lower(): s for s in pool}
    if len(scis) == 1:
        one = list(scis)[0]
        hit = by_sci.get(one.lower())
        if hit:
            return hit, "catalogo"
        return None, "conflicto:catalogo-dice-" + one + "-fuera-del-inventario"

    key = slug(dname.replace("_", "-"))
    grp = [s for s in pool if species_folder(s) == grupo]

    def uniq(cands, rung):
        if len(cands) == 1:
            return cands[0], rung
        if len(cands) > 1:
            return None, "ambiguo:" + rung + "(" + str(len(cands)) + ")"
        return None, None

    for rung, cands in (
        ("cientifico", [s for s in pool if slug(s["scientific_name"]) == key]),
        ("comun", [s for s in grp if slug(s.get("common_name") or "") == key]),
        ("prefijo", [s for s in grp if slug(s.get("common_name") or "").startswith(key + "-")]),
    ):
        got, why = uniq(cands, rung)
        if why:
            return got, why

    ktok = [t for t in key.split("-") if t]
    hits = []
    for s in grp:
        stok = set((slug(s.get("common_name") or "") + "-" + slug(s["scientific_name"])).split("-"))
        if ktok and all(any(tok_match(t, u) for u in stok) for t in ktok):
            hits.append(s)
    got, why = uniq(hits, "epiteto")
    return (got, why) if why else (None, "sin-candidato")


# ---------- plan ----------
def build_plan(m):
    _, by_sci = m.build_closed_set()
    pool = list(by_sci.values())
    common_counts = {}
    for s in pool:
        c = (s.get("common_name") or "").strip()
        if c:
            k = m.slug(c)
            common_counts[k] = common_counts.get(k, 0) + 1

    canon = {}   # (grupo, carpeta) -> especie
    for s in pool:
        canon[(m.species_folder(s), m.common_dirname(s, common_counts))] = s

    cat = m.load_json(m.CATALOG) if m.CATALOG.exists() else {"photos": []}
    by_hash = {p["hash"]: p for p in cat["photos"]}

    moves, orphans = [], []
    for grupo in sorted({g for g, _ in canon}):
        d = m.FOTOS / grupo
        if not d.is_dir():
            continue
        for sub in sorted(x for x in d.iterdir() if x.is_dir()):
            if (grupo, sub.name) in canon:
                continue
            files = sorted(x for x in sub.rglob("*") if x.is_file())
            hashes = {f: m.sha256(f) for f in files}
            sp, rung = resolve(sub.name, grupo,
                               [by_hash.get(h, {}).get("scientific_name") for h in hashes.values()],
                               pool, m.slug, m.species_folder)
            rec = {"from": grupo + "/" + sub.name, "n": len(files), "rung": rung,
                   "to": None, "scientific_name": None}
            orphans.append(rec)
            if not sp:
                continue
            dest = m.species_folder(sp) + "/" + m.common_dirname(sp, common_counts)
            rec["to"], rec["scientific_name"] = dest, sp["scientific_name"]
            dest_dir = m.FOTOS / dest
            # Un hash que ya vive en el destino es una copia: se aparta, no se pisa.
            present = ({m.sha256(x) for x in dest_dir.rglob("*") if x.is_file()}
                       if dest_dir.is_dir() else set())
            for f in files:
                h = hashes[f]
                dup = h in present
                present.add(h)
                stem = ((by_hash.get(h, {}).get("date") or "")[:10] or "sinfecha") + "_" + h[:8]
                tgt = ((m.FOTOS / "_duplicados" / (grupo + "__" + sub.name) / f.name) if dup
                       else (dest_dir / (stem + f.suffix.lower())))
                moves.append({"src": str(f.relative_to(m.FOTOS.parent)).replace("\\", "/"),
                              "dst": str(tgt.relative_to(m.FOTOS.parent)).replace("\\", "/"),
                              "hash": h, "dup": dup, "rung": rung,
                              "scientific_name": sp["scientific_name"],
                              "species_id": m.slug(sp["scientific_name"]),
                              "category": m.species_folder(sp),
                              "in_catalog": h in by_hash})
    return orphans, moves, by_hash, cat


MEDIA_EXT = {".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".m4v", ".avi", ".heic", ".heif"}


def scan_disk(m):
    """hash -> rutas en disco. Se hace una sola vez y se reutiliza."""
    disk = {}
    for f in m.FOTOS.rglob("*"):
        if f.is_file() and f.suffix.lower() in MEDIA_EXT:
            disk.setdefault(m.sha256(f), []).append(f)
    return disk


def build_repairs(m, cat, disk, moving):
    """Rutas del catalogo que ya no existen. Casi 8 de cada 10 registros estaban asi:
    ordenar a mano una foto a `nuestra_historia/` la mueve en disco pero no en el
    catalogo, y desde ese momento `23_catalog_to_media.py` publica una tarjeta que
    apunta a un archivo que no esta. El hash prueba la identidad, asi que reparar la
    ruta no es una conjetura; lo que no aparece en disco NO se borra, se reporta."""
    rep, lost = [], []
    for p in cat["photos"]:
        f = p.get("file")
        if not f or (m.FOTOS.parent / f).exists() or f in moving:
            continue
        cands = disk.get(p["hash"])
        if not cands:
            lost.append(f)
            continue
        # Si el archivo esta duplicado en disco, gana la copia cuya carpeta raiz
        # coincide con la categoria registrada; si no, la primera en orden estable.
        cands = sorted(cands, key=lambda x: (x.relative_to(m.FOTOS).parts[0] != (p.get("category") or ""),
                                             str(x)))
        rep.append({"hash": p["hash"], "old": f,
                    "new": str(cands[0].relative_to(m.FOTOS.parent)).replace("\\", "/")})
    return rep, lost


def catalog_entry(mv, m):
    """Alta en el catalogo de un archivo que nunca paso por 14_. `reason` deja dicho
    que lo decidio esta reconciliacion y con que evidencia: sin eso, un registro
    puesto a mano es indistinguible de una clasificacion del modelo."""
    src = m.FOTOS.parent / mv["src"]
    date, latlon = None, None
    try:
        date, latlon = m.read_exif(src)
    except Exception:
        pass
    return {"hash": mv["hash"], "file": mv["dst"], "category": mv["category"],
            "kind": "video" if src.suffix.lower() in m.VIDEO_EXT else "photo",
            "species_id": mv["species_id"], "scientific_name": mv["scientific_name"],
            "clip_category": "", "clip_score": 0.0, "bioclip_score": 0.0,
            "punto": None, "punto_dist_m": None, "date": date,
            "lat": latlon[0] if latlon else None, "lon": latlon[1] if latlon else None,
            "reason": "reconciliado:" + mv["rung"], "reviewed": False}


def main():
    if "--selftest" in sys.argv:
        return selftest()
    m = _load("14_classify_photos.py")
    for i, a in enumerate(sys.argv):
        if a == "--rollback":
            p = Path(sys.argv[i + 1])
            return rollback(m, p if p.is_absolute() else HERE / p)

    apply = "--apply" in sys.argv
    orphans, moves, by_hash, cat = build_plan(m)
    disk = scan_disk(m)
    # Los que este mismo pase va a mover se resuelven abajo, no aqui: si no, la
    # reparacion escribiria la ruta vieja justo antes de que el archivo cambie de sitio.
    repairs, lost = build_repairs(m, cat, disk, {x["src"] for x in moves})

    print("\nCarpetas huerfanas: %d   archivos: %d\n"
          % (len(orphans), sum(o["n"] for o in orphans)))
    for o in sorted(orphans, key=lambda x: (x["to"] is None, -x["n"])):
        arrow = ("-> " + o["to"]) if o["to"] else "-> (se queda como esta)"
        print("  %-44s n=%3d  [%-38s] %s" % (o["from"], o["n"], o["rung"], arrow))
    dups = [x for x in moves if x["dup"]]
    news = [x for x in moves if not x["in_catalog"] and not x["dup"]]
    print("\n  a mover: %d   duplicados apartados: %d   altas en el catalogo: %d"
          % (len(moves) - len(dups), len(dups), len(news)))
    unres = [o for o in orphans if not o["to"] and o["n"]]
    if unres:
        print("  sin resolver: %d carpetas / %d archivos — se reportan y NO se tocan"
              % (len(unres), sum(o["n"] for o in unres)))
    vac = [o for o in orphans if not o["n"]]
    if vac:
        # Se borran aunque no resuelvan: un directorio vacio no guarda trabajo de nadie,
        # y dejarlo hace que `check_fotos_catalog.py` siga avisando para siempre.
        print("  carpetas vacias que se eliminaran: " + ", ".join(o["from"] for o in vac))

    print("\nRutas del catalogo que ya no existen: %d de %d registros"
          % (len(repairs) + len(lost), len(cat["photos"])))
    print("  reparables por hash (el archivo se movio):   %d" % len(repairs))
    print("  el archivo no esta en fotos/ (se reportan):  %d" % len(lost))
    if lost:
        print("    ejemplos: " + ", ".join(lost[:3]))
    sin_reg = sum(1 for h in disk if h not in {p["hash"] for p in cat["photos"]})
    print("  archivos en disco fuera del catalogo:        %d  (archivo historico"
          " ordenado a mano antes de que existiera el catalogo)" % sin_reg)

    man = HERE / "_reconcile_manifest.json"
    man.write_text(json.dumps({"orphans": orphans, "moves": moves,
                               "repairs": repairs, "lost": lost},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n  manifiesto: " + str(man))
    if not apply:
        print("  (dry-run — nada tocado; repite con --apply)")
        return

    ts = time.strftime("%Y%m%d-%H%M%S")
    bak = m.CATALOG.with_name(m.CATALOG.name + ".bak-" + ts)
    shutil.copy2(m.CATALOG, bak)
    done = []
    for mv in moves:
        src, dst = m.FOTOS.parent / mv["src"], m.FOTOS.parent / mv["dst"]
        if not src.exists():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():                       # no pisar jamas: se desambigua el nombre
            dst = dst.with_name(dst.stem + "_" + mv["hash"][:4] + dst.suffix)
        shutil.move(str(src), str(dst))
        done.append({"src": mv["src"],
                     "dst": str(dst.relative_to(m.FOTOS.parent)).replace("\\", "/")})
        if mv["dup"]:
            continue
        prev = by_hash.get(mv["hash"])
        if prev:
            prev["file"] = done[-1]["dst"]     # ya estaba: solo cambio de sitio
        else:
            cat["photos"].append(catalog_entry(mv, m))
    for r in repairs:
        p = by_hash.get(r["hash"])
        if p and p.get("file") == r["old"]:
            p["file"] = r["new"]
    m.CATALOG.write_text(json.dumps(cat, ensure_ascii=False, indent=1), encoding="utf-8")

    rmd = []
    for o in orphans:
        d = m.FOTOS / o["from"]
        if d.is_dir() and not any(d.rglob("*")):
            d.rmdir()
            rmd.append(o["from"])
    log = HERE / ("_reconcile_moves-" + ts + ".json")
    log.write_text(json.dumps({"moves": done, "rmdir": rmd, "catalog_bak": bak.name},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n  OK movidos %d - carpetas vacias eliminadas %d" % (len(done), len(rmd)))
    print("  deshacer:  python data_prep/37_reconcile_folders.py --rollback " + log.name)
    # Mover no basta: las altas del catalogo solo llegan a la app cuando el puente
    # vuelve a correr. Es `28_`, no `23_`: hay DOS catalogos con dos consumidores
    # distintos, y 23_/26_/27_ leen el del archivo historico
    # (`_archive_work/catalog_fotos-reserva-cantares.json`), no este.
    print("  para que lleguen a la app:  python data_prep/28_mirror_app_folder.py")


def rollback(m, log):
    d = json.loads(log.read_text(encoding="utf-8"))
    back = 0
    for mv in reversed(d["moves"]):
        src, dst = m.FOTOS.parent / mv["dst"], m.FOTOS.parent / mv["src"]
        if src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            back += 1
    bak = m.CATALOG.parent / d["catalog_bak"]
    if bak.exists():
        shutil.copy2(bak, m.CATALOG)
    print("  devueltos %d archivos; catalogo restaurado desde %s" % (back, bak.name))


# ---------- prueba de la escalera, sin disco ni inventario real ----------
def selftest():
    def slug(s):
        return str(s).lower().replace(" ", "-").replace(".", "")

    def sf(s):
        return s["group"]

    P = [{"scientific_name": "Chamaepetes goudotii", "common_name": "Pava maraquera", "group": "aves"},
         {"scientific_name": "Penelope montagnii", "common_name": "Pava Andina", "group": "aves"},
         {"scientific_name": "Aglaiocercus kingii", "common_name": "Silfo de King", "group": "aves"},
         {"scientific_name": "Andigena nigrirostris", "common_name": "Tucan pechiazul", "group": "aves"},
         {"scientific_name": "Sciurus granatensis", "common_name": "Ardilla comun", "group": "mamiferos"},
         {"scientific_name": "Piaya cayana", "common_name": "Cuco Ardilla Comun", "group": "aves"},
         {"scientific_name": "Leandra nervosa", "common_name": "Niguito", "group": "plantas"},
         {"scientific_name": "Miconia sp", "common_name": "Niguito", "group": "plantas"},
         # Par real del inventario: los epitetos estan a DOS caracteres. Sirve para
         # fijar el umbral — con `lev <= 2` la carpeta de abajo dejaria de resolver.
         {"scientific_name": "Ceroxylon quindiuense", "common_name": "Palma de cera", "group": "arboles"},
         {"scientific_name": "Sphaeropteris quindiuensis", "common_name": "Helecho arboreo", "group": "arboles"}]

    def R(d, g, c=()):
        return resolve(d, g, list(c), P, slug, sf)

    def sci(r):
        return r[0]["scientific_name"] if r[0] else None

    # el catalogo manda por encima del nombre de la carpeta
    assert R("aglaiocercus-kingii", "aves", ["Aglaiocercus kingii"])[1] == "catalogo"
    # ...y cuando discrepa, NADA se mueve. Es el caso real de andigena_nigrirostris.
    r = R("andigena_nigrirostris", "aves", ["Aulacorhynchus albivitta", "Cecropia peltata"])
    assert r[0] is None and r[1].startswith("conflicto:"), r
    # un cientifico que el catalogo asigna pero no esta en el inventario tampoco mueve
    assert R("x", "aves", ["Aulacorhynchus albivitta"])[0] is None
    # nombre cientifico y comun exactos
    assert sci(R("aglaiocercus-kingii", "aves")) == "Aglaiocercus kingii"
    assert sci(R("pava-andina", "aves")) == "Penelope montagnii"
    # prefijo — y el GRUPO es lo que evita que 'ardilla' se vaya al Cuco Ardilla Comun
    assert sci(R("ardilla", "mamiferos")) == "Sciurus granatensis"
    assert sci(R("ardilla", "aves")) == "Piaya cayana"
    # epiteto a un caracter: goudotti -> goudotii, con 'pava' anclando la especie
    assert sci(R("pava_goudotti", "aves")) == "Chamaepetes goudotii", R("pava_goudotti", "aves")
    # dos especies con el mismo nombre comun no se desempatan solas — y hay que
    # exigir el MOTIVO: si la ambiguedad se ignorase y se quedase la primera, el
    # resultado seguiria siendo distinto de None por otro camino y la prueba pasaria.
    assert R("niguito", "plantas") == (None, "ambiguo:comun(2)"), R("niguito", "plantas")
    # y lo que no esta, no se inventa: 'silvo' no puede caer en 'silva'
    assert R("silvo-silvo", "plantas") == (None, "sin-candidato")
    assert R("murcielago", "mamiferos") == (None, "sin-candidato")
    assert R("afrechero", "aves") == (None, "sin-candidato")
    # el umbral de DISTANCIA. En el inventario real hay 16 pares de aves cuyos
    # epitetos estan a un caracter y 100 a dos: aflojarlo convierte resoluciones
    # unicas en colisiones. Con `lev <= 2` esta deja de resolver.
    assert sci(R("quindiuense", "arboles")) == "Ceroxylon quindiuense"
    # el umbral de LONGITUD: a un caracter, 'pava'/'pavo' son palabras distintas
    assert tok_match("goudotti", "goudotii") and not tok_match("pava", "pavo")
    assert lev("goudotti", "goudotii") == 1 and lev("", "abc") == 3
    print("OK — 37_reconcile_folders selftest (resuelve lo probado y se abstiene del resto)")


if __name__ == "__main__":
    main()
