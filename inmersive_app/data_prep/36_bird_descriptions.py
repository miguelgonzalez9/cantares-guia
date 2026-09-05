#!/usr/bin/env python3
"""
36_bird_descriptions.py — descripcion de identificacion para las aves de la reserva.

De 602 aves del inventario solo 10 tienen descripcion, y las 10 son `llm_draft`
sin revisar. La app ensena una ficha vacia justo donde hace falta: "que es lo que
estoy viendo".

DE DONDE SALE EL TEXTO, y por que de ahi:
  · eBird NO sirve descripciones. Se comprobo contra su API: da taxonomia,
    frecuencia y listas, nunca prosa de identificacion.
  · El RESUMEN de Wikipedia tampoco sirve, ni en espanol ni en ingles: es
    taxonomia y distribucion ("es una especie de ave de la familia Cracidae que
    vive en los Andes"), que no ayuda a reconocer nada en el campo.
  · La seccion **"Description" del articulo INGLES** si: "50 to 65 cm ... brown
    head and neck, dark upperparts, bright chestnut belly, pale blue facial skin,
    and red eyes". Eso es lo que se pidio.
  La Wikipedia espanola de estas especies casi siempre es un esbozo sin seccion
  equivalente; el espanol sale de la pasada de traduccion (38_i18n_audit.py).

ALCANCE: las aves con `seen = true` (censo o hotspot de eBird de Cantares), 224
de 602. Las 378 solo "potenciales" se quedan sin descripcion a proposito: no se
han visto en la reserva, y llenarles la ficha las presentaria como residentes.

DONDE NO HAY SECCION "Description", SE DEJA VACIO Y SE REPORTA. Abstenerse antes
que rellenar: un parrafo generico de genero puesto sobre una especie concreta es
peor que un hueco, porque parece un dato.

Dos guardas contra el texto equivocado:
  1. Si el articulo al que redirige el nombre cientifico es el GENERO (Wikipedia
     redirige ahi cuando la especie no tiene articulo propio), se descarta: su
     "Description" describe al genero entero, no a esta ave.
  2. Nunca se pisa un texto revisado ni escrito por el administrador. Los 10
     `llm_draft` tampoco se tocan sin `--replace-drafts`, aunque un texto de
     Wikipedia con atribucion sea mejor que un borrador anonimo: es una decision
     de quien manda, no del script.

LICENCIA: Wikipedia es CC BY-SA 4.0, que EXIGE atribucion. Por eso se escribe
`description_url` y `description_license` en cada ficha, y por eso hace falta
correr antes la migracion `app/public/data/27_description_provenance.sql`.

Uso:
    python data_prep/36_bird_descriptions.py                  # manifiesto, no escribe
    python data_prep/36_bird_descriptions.py --limit 20
    python data_prep/36_bird_descriptions.py --max-seconds 300
    python data_prep/36_bird_descriptions.py --apply
    python data_prep/36_bird_descriptions.py --rollback
    python data_prep/36_bird_descriptions.py --selftest       # sin red

Reanudable: cada articulo consultado se cachea en `_wiki_cache/`, asi que cortar
la corrida y repetirla no vuelve a pedir nada a Wikipedia. Idempotente: correrlo
dos veces no cambia nada la segunda.
"""

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
SPECIES = HERE.parent / "app" / "public" / "data" / "species.json"
CACHE = HERE / "_wiki_cache"
MANIFEST = HERE / "_bird_descriptions.json"

API = "https://en.wikipedia.org/w/api.php"
# Wikipedia pide identificarse con algo que permita contactar a quien corre el bot.
UA = {"User-Agent": "CantaresBot/1.0 (Reserva Natural Cantares; miguelgonlug@gmail.com)"}
LICENSE = "CC BY-SA 4.0"
PAUSE = 0.2          # cortesia entre peticiones; el limite real es mucho mas alto
MIN_CHARS = 120      # menos que esto no es una descripcion, es un resto de plantilla


def argval(flag, default=None, cast=str):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return cast(sys.argv[i + 1])
    return default


# ---------- extraccion de texto (probada sin red por --selftest) ----------
class _Text(HTMLParser):
    """HTML de una seccion -> texto plano. Se descartan las notas al pie (`sup`),
    las tablas y los enlaces [edit], que si no acaban dentro de la prosa."""

    SKIP = {"sup", "style", "table", "figure"}

    def __init__(self):
        super().__init__()
        self.out = []
        # PILA, no contador. Lo que dispara el salto puede ser cualquier etiqueta
        # (el enlace [edit] es un `span` con class mw-editsection), y un contador
        # que solo decrementa con las etiquetas de SKIP no vuelve nunca a cero:
        # el resto de la seccion se pierde entera y sale texto vacio.
        self.stack = []

    def handle_starttag(self, tag, attrs):
        cls = dict(attrs).get("class") or ""
        if self.stack or tag in self.SKIP or "mw-editsection" in cls or "reference" in cls:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
        if tag in ("p", "li"):
            self.out.append("\n")

    def handle_data(self, data):
        if not self.stack:
            self.out.append(data)


def html_to_text(html):
    p = _Text()
    p.feed(html)
    t = "".join(p.out)
    t = re.sub(r"\[\s*edit\s*\]", " ", t)          # por si el marcado cambia de clase
    t = re.sub(r"\[\s*\d+\s*\]", "", t)            # restos de nota al pie
    t = re.sub(r"[ \t\xa0]+", " ", t)
    t = re.sub(r"\n{2,}", "\n\n", t)
    t = re.sub(r"^\s*Description\s*", "", t.strip())
    return t.strip()


def pick_section(sections, want="description"):
    """Indice de la seccion pedida. Solo el titulo EXACTO: 'Description and
    taxonomy' o 'Habitat description' hablan de otra cosa y colar una por otra es
    justo el error que este script existe para no cometer."""
    for s in sections:
        if (s.get("line") or "").strip().lower() == want:
            return s.get("index")
    return None


def is_genus_page(title, scientific_name):
    """Wikipedia redirige al GENERO cuando la especie no tiene articulo propio, y
    ese articulo tiene su propia seccion Description — del genero entero. Aceptarla
    seria atribuir a esta ave los rasgos de sus primas."""
    return title.strip().lower() == scientific_name.split()[0].strip().lower()


# ---------- red ----------
def api(params):
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def fetch(sci):
    """{title, url, text} | {skip: motivo}. Cacheado en disco por especie."""
    CACHE.mkdir(exist_ok=True)
    key = re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")
    cf = CACHE / (key + ".json")
    if cf.exists():
        return json.loads(cf.read_text(encoding="utf-8"))

    def save(d):
        cf.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
        return d

    try:
        d = api({"action": "parse", "page": sci, "prop": "sections", "redirects": 1})
    except urllib.error.HTTPError as e:
        # 404 = no hay articulo. Se cachea como tal: es una respuesta, no un fallo.
        if e.code == 404:
            return save({"skip": "sin articulo en Wikipedia"})
        raise
    if "error" in d:
        return save({"skip": "sin articulo en Wikipedia (%s)" % d["error"].get("code")})
    title = d["parse"]["title"]
    if is_genus_page(title, sci):
        return save({"skip": "redirige al genero (%s): describiria al genero, no a la especie" % title})
    idx = pick_section(d["parse"]["sections"])
    if idx is None:
        return save({"skip": "el articulo no tiene seccion Description", "title": title})
    time.sleep(PAUSE)
    h = api({"action": "parse", "page": sci, "section": idx, "prop": "text", "redirects": 1})
    txt = html_to_text(h["parse"]["text"])
    if len(txt) < MIN_CHARS:
        return save({"skip": "seccion Description demasiado corta (%d)" % len(txt), "title": title})
    return save({"title": title, "text": txt,
                 "url": "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"))})


# ---------- pasada ----------
def targets(data, replace_drafts):
    """Aves vistas en la reserva a las que les falta descripcion. Devuelve tambien
    por que se salta cada una de las demas, para que el informe lo diga."""
    todo, skipped = [], []
    for s in data["species"]:
        if s.get("group") != "ave" or not s.get("seen"):
            continue
        src = (s.get("description_source") or "").strip()
        has = bool((s.get("description_en") or "").strip())
        if s.get("description_reviewed") or src == "admin":
            skipped.append((s["scientific_name"], "revisada o escrita por el admin"))
        elif has and src == "llm_draft" and not replace_drafts:
            skipped.append((s["scientific_name"], "borrador de IA (usa --replace-drafts)"))
        elif has and src == "wikipedia":
            skipped.append((s["scientific_name"], "ya traida de Wikipedia"))
        elif has and src not in ("llm_draft", "wikipedia", ""):
            skipped.append((s["scientific_name"], "ya tiene texto de " + src))
        else:
            todo.append(s)
    return todo, skipped


def main():
    if "--selftest" in sys.argv:
        return selftest()
    data = json.loads(SPECIES.read_text(encoding="utf-8"))
    if "--rollback" in sys.argv:
        return rollback()

    apply = "--apply" in sys.argv
    limit = argval("--limit", None, int)
    budget = argval("--max-seconds", None, float)
    todo, skipped = targets(data, "--replace-drafts" in sys.argv)
    if limit:
        todo = todo[:limit]

    print("\nAves vistas en la reserva sin descripcion: %d   (se saltan %d)"
          % (len(todo), len(skipped)))
    t0 = time.time()
    got, miss = [], []
    for i, s in enumerate(todo, 1):
        if budget and time.time() - t0 > budget:
            print("  ... presupuesto de %.0fs agotado; lo cacheado se conserva,"
                  " vuelve a correrlo para seguir" % budget)
            break
        sci = s["scientific_name"]
        try:
            r = fetch(sci)
        except Exception as e:
            miss.append({"scientific_name": sci, "why": "%s: %s" % (type(e).__name__, e)})
            print("  %3d/%d  %-32s ! %s" % (i, len(todo), sci, type(e).__name__))
            continue
        if "skip" in r:
            miss.append({"scientific_name": sci, "why": r["skip"]})
            print("  %3d/%d  %-32s - %s" % (i, len(todo), sci, r["skip"]))
        else:
            got.append({"id": s["id"], "scientific_name": sci, "common_name": s.get("common_name"),
                        "title": r["title"], "url": r["url"], "text": r["text"]})
            print("  %3d/%d  %-32s ok %-34s %d car." % (i, len(todo), sci, r["title"], len(r["text"])))
        time.sleep(PAUSE)

    MANIFEST.write_text(json.dumps({"got": got, "missing": miss, "skipped": skipped},
                                   ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n  con descripcion: %d   sin fuente utilizable: %d" % (len(got), len(miss)))
    if miss:
        from collections import Counter
        for why, n in Counter(m["why"].split("(")[0].strip() for m in miss).most_common():
            print("     %-58s %d" % (why, n))
    print("  manifiesto: %s" % MANIFEST)
    if not apply:
        print("  (dry-run — species.json intacto; repite con --apply)")
        return

    bak = SPECIES.with_name(SPECIES.name + ".bak-" + time.strftime("%Y%m%d-%H%M%S"))
    bak.write_text(SPECIES.read_text(encoding="utf-8"), encoding="utf-8")
    by_id = {s["id"]: s for s in data["species"]}
    for g in got:
        s = by_id[g["id"]]
        s["description_en"] = g["text"]
        s["description_source"] = "wikipedia"
        s["description_url"] = g["url"]
        s["description_license"] = LICENSE
        s["description_reviewed"] = False
    SPECIES.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n  OK escritas %d descripciones en species.json  (copia: %s)" % (len(got), bak.name))
    print("  ANTES de que esto sirva en la nube hay que correr, UNA vez, en el SQL")
    print("  Editor de Supabase:  app/public/data/27_description_provenance.sql")
    print("  Sin esa migracion el upsert falla entero y la edicion se encola sin subir.")
    print("  deshacer:  python data_prep/36_bird_descriptions.py --rollback")


def rollback():
    baks = sorted(SPECIES.parent.glob(SPECIES.name + ".bak-*"))
    if not baks:
        print("  no hay copia que restaurar")
        return 1
    SPECIES.write_text(baks[-1].read_text(encoding="utf-8"), encoding="utf-8")
    print("  species.json restaurado desde %s" % baks[-1].name)


# ---------- prueba de la logica pura, sin red ----------
def selftest():
    secs = [{"index": 1, "line": "Taxonomy and systematics"},
            {"index": 2, "line": "Description"},
            {"index": 3, "line": "Distribution and habitat"}]
    assert pick_section(secs) == 2
    # Solo el titulo exacto: 'Habitat description' habla de otra cosa.
    assert pick_section([{"index": 1, "line": "Habitat description"}]) is None
    assert pick_section([{"index": 1, "line": "Description and taxonomy"}]) is None

    # La guarda del genero. Wikipedia redirige ahi cuando no hay articulo de especie.
    assert is_genus_page("Miconia", "Miconia sp.")
    assert not is_genus_page("Sickle-winged guan", "Chamaepetes goudotii")
    # El articulo puede titularse con el binomio: eso es la especie, no el genero.
    assert not is_genus_page("Chamaepetes goudotii", "Chamaepetes goudotii")

    html = ('<div class="mw-heading"><h2>Description</h2>'
            '<span class="mw-editsection"><a>edit</a></span></div>'
            '<p>The sickle-winged guan is 50 to 65\xa0cm long<sup class="reference">[1]</sup> '
            'and weighs 550 to 800\xa0g.</p><p>Juveniles are duller.</p>'
            '<table><tr><td>no</td></tr></table>')
    t = html_to_text(html)
    assert t.startswith("The sickle-winged guan is 50 to 65 cm long"), t
    assert "[1]" not in t and "edit" not in t and "no" not in t.split(), t
    assert "Juveniles are duller." in t

    # A quien se le pone y a quien no. Lo revisado y lo del admin NO se tocan.
    data = {"species": [
        {"id": "a", "group": "ave", "seen": True, "scientific_name": "A a"},
        {"id": "b", "group": "ave", "seen": False, "scientific_name": "B b"},
        {"id": "c", "group": "flora", "seen": True, "scientific_name": "C c"},
        {"id": "d", "group": "ave", "seen": True, "scientific_name": "D d",
         "description_en": "x", "description_source": "admin"},
        {"id": "e", "group": "ave", "seen": True, "scientific_name": "E e",
         "description_en": "x", "description_source": "llm_draft"},
        {"id": "f", "group": "ave", "seen": True, "scientific_name": "F f",
         "description_en": "x", "description_source": "censo_2021"},
        {"id": "g", "group": "ave", "seen": True, "scientific_name": "G g",
         "description_en": "x", "description_reviewed": True}]}
    todo, sk = targets(data, replace_drafts=False)
    assert [s["id"] for s in todo] == ["a"], [s["id"] for s in todo]
    assert len(sk) == 4, sk
    # Con --replace-drafts entra el borrador de IA, y SOLO ese.
    todo2, _ = targets(data, replace_drafts=True)
    assert [s["id"] for s in todo2] == ["a", "e"], [s["id"] for s in todo2]
    print("OK — 36_bird_descriptions selftest (seccion exacta, guarda de genero, "
          "no pisa lo revisado)")


if __name__ == "__main__":
    sys.exit(main() or 0)
