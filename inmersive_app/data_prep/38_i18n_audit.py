#!/usr/bin/env python3
"""
38_i18n_audit.py — que falta por traducir al ingles, en el archivo y en la nube.

La app degrada bien: `L()` cae al espanol cuando falta el ingles y `scriptLine`
se niega a leer un texto espanol con voz inglesa. Lo que NO existia era saber
QUE falta. En el repo no hay una sola llamada de traduccion, asi que todo lo que
se escribe desde el telefono nace solo en espanol y ahi se queda.

No traduce por si mismo, y es deliberado: una API de traduccion automatica sobre
nombres de aves y guiones de audioguia produce texto que suena a maquina en la
voz de la reserva. El ciclo es:

    1. correr sin argumentos   -> `_i18n_pending.json` con cada campo pendiente
    2. rellenar el campo `en`  -> lo hace Claude en sesion, con criterio
    3. correr con --apply      -> escribe species.json (.bak + --rollback) y
                                  EMITE `app/public/data/28_i18n_apply.sql`
                                  con las filas de la nube

COMO ENCUENTRA LOS PARES. Una sola regla recursiva, porque el esquema usa dos
formas distintas y hay tres niveles de anidamiento:
    · hermanos:   {"title": "Cascada", "title_en": null}
    · es/en:      {"es": "Pino rey...", "en": null}   <- guiones de audioguia
Asi entran sin listarlas a mano las paginas de `content.doc` (secciones, hitos,
entradillas) y los guiones de `routes.scripts`, que es donde vive lo que se
escribe de verdad desde el telefono.

LEE LA NUBE CON LA CLAVE ANON, que es publica por diseno y ya esta en el repo
(`js/cloud.js`): las politicas RLS dan lectura publica. ESCRIBIR es otra cosa —
`data_prep/.env` no tiene credenciales de Supabase y no debe tenerlas, asi que
la mitad de la nube sale como SQL revisable en vez de aplicarse a escondidas.

Uso:
    python data_prep/38_i18n_audit.py               # informe + _i18n_pending.json
    python data_prep/38_i18n_audit.py --no-cloud    # solo species.json
    python data_prep/38_i18n_audit.py --apply
    python data_prep/38_i18n_audit.py --rollback
    python data_prep/38_i18n_audit.py --selftest    # sin red
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "app" / "public" / "data"
SPECIES = DATA / "species.json"
CLOUD_JS = HERE.parent / "app" / "public" / "js" / "cloud.js"
PENDING = HERE / "_i18n_pending.json"
SQL_OUT = DATA / "28_i18n_apply.sql"

# Tablas y su clave primaria. `content` y `routes` entran enteras porque lo que
# hay que traducir vive DENTRO de un jsonb, no en columnas sueltas.
TABLES = {"species": "id", "waypoints": "id", "media": "id",
          "routes": "id", "content": "id"}


# ---------- la regla, probada sin red ----------
def translatable(node, out=None):
    """Nombres de campo que EN ALGUN SITIO del corpus llevan un `_en`.

    Hace falta porque el par puede no existir: 98 especies no tienen siquiera la
    clave `common_name_en`, asi que buscar solo hermanos presentes las daba por
    traducidas. Se deriva del propio corpus en vez de mantener una lista a mano:
    un campo nuevo que nazca con su `_en` entra solo, y `scientific_name` o `id`
    —que nunca lo llevan— no entran nunca."""
    out = set() if out is None else out
    if isinstance(node, list):
        for v in node:
            translatable(v, out)
    elif isinstance(node, dict):
        for k, v in node.items():
            if k.endswith("_en") and len(k) > 3:
                out.add(k[:-3])
            translatable(v, out)
    return out


def find_pending(node, path=(), fields=None):
    """Rinde (ruta, texto_es) por cada campo con original en espanol y sin ingles.

    La ruta es una tupla de claves/indices: es lo que permite volver a escribir
    exactamente ese campo despues, sin tener que conocer la forma del documento."""
    if fields is None:
        fields = translatable(node)
    if isinstance(node, list):
        for i, v in enumerate(node):
            yield from find_pending(v, path + (i,), fields)
        return
    if not isinstance(node, dict):
        return
    # forma {es, en}: los guiones de la audioguia
    if "es" in node and "en" in node:
        es = node.get("es")
        if isinstance(es, str) and es.strip() and not str(node.get("en") or "").strip():
            yield path + ("en",), es
    for k, v in node.items():
        # forma hermana: `titulo` / `titulo_en`, exista ya la clave o no.
        # Basta con `k in fields`: si algun nodo del corpus trae `k_en`, `k` ya
        # esta en el conjunto — comprobar ademas el hermano de ESTE nodo seria una
        # rama que ninguna entrada puede alcanzar.
        if not k.endswith("_en") and k in fields:
            if isinstance(v, str) and v.strip() and not str(node.get(k + "_en") or "").strip():
                yield path + (k + "_en",), v
        yield from find_pending(v, path + (k,), fields)


def get_path(doc, path):
    for k in path:
        doc = doc[k]
    return doc


def set_path(doc, path, value):
    for k in path[:-1]:
        doc = doc[k]
    doc[path[-1]] = value


# ---------- nube (solo lectura) ----------
def anon_key():
    m = re.search(r"anonKey:\s*'([^']+)'", CLOUD_JS.read_text(encoding="utf-8"))
    u = re.search(r"url:\s*'([^']+)'", CLOUD_JS.read_text(encoding="utf-8"))
    return (u.group(1) if u else None), (m.group(1) if m else None)


def fetch_table(url, key, table):
    q = url + "/rest/v1/" + table + "?select=" + urllib.parse.quote("*")
    req = urllib.request.Request(q, headers={"apikey": key, "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


# ---------- SQL para la nube ----------
def sql_literal(s):
    return "'" + str(s).replace("'", "''") + "'"


def sql_for(item):
    """Una sentencia por campo. Idempotente por construccion: solo escribe donde
    sigue faltando el ingles, asi que pegar el archivo dos veces no pisa nada que
    se haya corregido a mano entre medias."""
    t, pk, path = item["table"], item["pk"], item["path"]
    val = sql_literal(item["en"])
    if len(path) == 1:                       # columna suelta: waypoints.title_en
        col = path[0]
        return ("update public.%s set %s = %s where id = %s"
                " and coalesce(%s, '') = '';" % (t, col, val, sql_literal(pk), col))
    # dentro de un jsonb: la primera clave es la columna, el resto la ruta.
    col, inner = path[0], path[1:]
    ruta = "{" + ",".join(str(x) for x in inner) + "}"
    return ("update public.%s set %s = jsonb_set(%s, %s, to_jsonb(%s::text), true)"
            " where id = %s and coalesce(%s #>> %s, '') = '';"
            % (t, col, col, sql_literal(ruta), val, sql_literal(pk),
               col, sql_literal(ruta)))


# ---------- pasada ----------
def collect(no_cloud):
    items = []
    data = json.loads(SPECIES.read_text(encoding="utf-8"))
    # Los campos traducibles se derivan del corpus ENTERO, no de cada registro:
    # una especie sin `common_name_en` no puede decir por si sola que ese campo
    # se traduce, y es justo la que hay que encontrar.
    campos = translatable(data["species"])
    for i, s in enumerate(data["species"]):
        for path, es in find_pending(s, (), campos):
            items.append({"source": "species.json", "table": None, "pk": s["id"],
                          "path": list(path), "idx": i, "es": es, "en": None})
    if no_cloud:
        return items, data, {}
    url, key = anon_key()
    rows_by_table = {}
    for t, pkcol in TABLES.items():
        try:
            rows = fetch_table(url, key, t)
        except Exception as e:
            print("  ! no se pudo leer %s: %s" % (t, e))
            continue
        rows_by_table[t] = rows
        campos_t = translatable(rows)
        for r in rows:
            for path, es in find_pending(r, (), campos_t):
                items.append({"source": "nube", "table": t, "pk": r[pkcol],
                              "path": list(path), "idx": None, "es": es, "en": None})
    return items, data, rows_by_table


def main():
    if "--selftest" in sys.argv:
        return selftest()
    if "--rollback" in sys.argv:
        baks = sorted(SPECIES.parent.glob(SPECIES.name + ".bak-*"))
        if not baks:
            print("  no hay copia que restaurar")
            return 1
        SPECIES.write_text(baks[-1].read_text(encoding="utf-8"), encoding="utf-8")
        print("  species.json restaurado desde " + baks[-1].name)
        return 0

    apply = "--apply" in sys.argv
    if apply and PENDING.exists():
        # En --apply manda el manifiesto ya traducido, no un barrido nuevo: si se
        # volviera a barrer se perderian las traducciones escritas en el archivo.
        items = json.loads(PENDING.read_text(encoding="utf-8"))["items"]
        data = json.loads(SPECIES.read_text(encoding="utf-8"))
    else:
        items, data, _ = collect("--no-cloud" in sys.argv)

    from collections import Counter
    print("\nCampos sin traducir: %d" % len(items))
    for k, n in Counter((i["source"] if not i["table"] else "nube/" + i["table"])
                        + " · " + i["path"][-1] for i in items).most_common(14):
        print("  %-46s %d" % (k, n))

    if not apply:
        PENDING.write_text(json.dumps({"_como": "rellena cada `en` y vuelve a correr"
                                       " con --apply", "items": items},
                                      ensure_ascii=False, indent=1), encoding="utf-8")
        print("\n  manifiesto: %s" % PENDING)
        print("  (dry-run — rellena los `en` y repite con --apply)")
        return 0

    listos = [i for i in items if str(i.get("en") or "").strip()]
    print("\n  con traduccion escrita: %d de %d" % (len(listos), len(items)))
    if not listos:
        print("  nada que aplicar: el manifiesto no tiene ningun `en` relleno.")
        return 1

    fichero = [i for i in listos if not i["table"]]
    if fichero:
        bak = SPECIES.with_name(SPECIES.name + ".bak-" + time.strftime("%Y%m%d-%H%M%S"))
        bak.write_text(SPECIES.read_text(encoding="utf-8"), encoding="utf-8")
        for i in fichero:
            set_path(data["species"][i["idx"]], i["path"], i["en"])
        SPECIES.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        print("  species.json: %d campos escritos (copia: %s)" % (len(fichero), bak.name))

    nube = [i for i in listos if i["table"]]
    if nube:
        head = ["-- Cantares — parche de datos 28: traducciones al ingles.",
                "-- NO es una migracion de esquema: no crea ni cambia columnas, solo rellena",
                "-- los `_en` que faltaban. Generado por data_prep/38_i18n_audit.py el "
                + time.strftime("%Y-%m-%d") + ".",
                "--",
                "-- Idempotente por construccion: cada sentencia escribe SOLO donde el ingles",
                "-- sigue vacio, asi que pegarlo dos veces no pisa nada corregido a mano entre",
                "-- medias. Se puede pegar en el SQL Editor de Supabase.", ""]
        body = [sql_for(i) for i in sorted(nube, key=lambda x: (x["table"], str(x["pk"])))]
        SQL_OUT.write_text("\n".join(head + body) + "\n", encoding="utf-8")
        print("  nube: %d campos -> %s  (pegar en el SQL Editor)" % (len(nube), SQL_OUT.name))
    return 0


# ---------- prueba de la regla, sin red ni archivos ----------
def selftest():
    doc = {"title": "Cascada", "title_en": None,
           "description": "Una de las cascadas.", "description_en": "One of the waterfalls.",
           "vacio": "", "vacio_en": None,
           "solo_en": None, "solo_en_en": None,
           "secciones": [{"titulo": "El bosque", "titulo_en": ""},
                         {"titulo": "El agua", "titulo_en": "The water"}],
           "scripts": {"punto_4": {"es": "Pino rey, magnolio.", "en": None},
                       "punto_5": {"es": "Mirador.", "en": "Lookout."},
                       # Un punto SIN guion no es trabajo pendiente: ofrecerlo
                       # inflaria la lista con huecos que nadie escribio nunca.
                       "punto_6": {"es": "   ", "en": None}}}
    got = sorted(find_pending(doc))
    assert got == [(("scripts", "punto_4", "en"), "Pino rey, magnolio."),
                   (("secciones", 0, "titulo_en"), "El bosque"),
                   (("title_en",), "Cascada")], got

    # El campo traducible se deduce del corpus, no de cada registro: una ficha SIN
    # la clave `_en` es exactamente la que hay que encontrar (98 especies estaban
    # asi y la primera version del barrido las daba por traducidas).
    corpus = [{"common_name": "Mirla", "common_name_en": "Blackbird",
               "scientific_name": "Turdus fuscater"},
              {"common_name": "Tabaquillo", "scientific_name": "Aegiphila grandis"}]
    campos = translatable(corpus)
    assert campos == {"common_name"}, campos      # scientific_name NUNCA lleva _en
    falta = [(p, e) for r in corpus for p, e in find_pending(r, (), campos)]
    assert falta == [(("common_name_en",), "Tabaquillo")], falta
    # Lo ya traducido NO reaparece (si no, --apply pisaria trabajo hecho)...
    assert not any(p == ("description_en",) for p, _ in got)
    # ...ni lo que no tiene original que traducir.
    assert not any(p[-1] == "vacio_en" for p, _ in got)

    # set_path escribe exactamente donde dijo la ruta, incluso 3 niveles adentro
    set_path(doc, ["scripts", "punto_4", "en"], "King pine, magnolia.")
    assert doc["scripts"]["punto_4"]["en"] == "King pine, magnolia."
    set_path(doc, ["secciones", 0, "titulo_en"], "The forest")
    assert doc["secciones"][0]["titulo_en"] == "The forest"
    set_path(doc, ["title_en"], "Waterfall")
    # Escritas las tres, no queda ninguna: la pasada es idempotente.
    assert not list(find_pending(doc)), list(find_pending(doc))

    # SQL: columna suelta y jsonb anidado, ambos con la guarda de idempotencia
    s = sql_for({"table": "waypoints", "pk": "punto_3", "path": ["title_en"], "en": "Waterfall"})
    assert "update public.waypoints set title_en = 'Waterfall'" in s
    assert "coalesce(title_en, '') = ''" in s, s
    s2 = sql_for({"table": "routes", "pk": "regeneracion",
                  "path": ["scripts", "punto_4", "en"], "en": "King pine."})
    assert "jsonb_set(scripts, '{punto_4,en}'" in s2, s2
    assert "scripts #>> '{punto_4,en}'" in s2, s2
    # Las comillas del espanol no pueden romper la sentencia.
    assert sql_literal("d'Este") == "'d''Este'"
    s3 = sql_for({"table": "waypoints", "pk": "p", "path": ["title_en"], "en": "It's here"})
    assert "'It''s here'" in s3, s3
    print("OK — 38_i18n_audit selftest (encuentra los dos esquemas, escribe por ruta,"
          " y el SQL es idempotente)")


if __name__ == "__main__":
    sys.exit(main() or 0)
