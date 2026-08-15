"""Baja los guiones de audioguía de Supabase al routes.json EMPAQUETADO.

Por qué existe: los guiones (`routes.scripts`) solo vivían en la nube. Bajo el
dosel no hay señal, así que `routeScript()` devolvía null y la audioguía nunca
sonaba — justo donde tiene que sonar. `data/routes.json` sí está precacheado por
el service worker, así que ahí los guiones viajan con la app.

La nube sigue mandando cuando hay señal (cloud-over-static, ver applyCloudRoutes
en app.js): esto es la SEMILLA del build, no una copia autoritativa. Correr
después de editar guiones en la app, antes de desplegar.

    python data_prep/29_pull_route_scripts.py            # muestra el diff
    python data_prep/29_pull_route_scripts.py --apply    # escribe routes.json

No destructivo por defecto (regla de data_prep): sin --apply no toca nada.
La anon key es pública por diseño (RLS protege los datos); se lee de cloud.js
para no tener dos copias que se desincronicen.
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLOUD_JS = ROOT / "app" / "public" / "js" / "cloud.js"
ROUTES = ROOT / "app" / "public" / "data" / "routes.json"


def cloud_creds():
    """URL + anon key, leídas del propio cloud.js (una sola fuente de verdad)."""
    src = CLOUD_JS.read_text(encoding="utf-8")
    url = re.search(r"url:\s*'([^']+)'", src)
    key = re.search(r"anonKey:\s*'([^']+)'", src)
    if not (url and key):
        sys.exit("No pude leer url/anonKey de cloud.js")
    return url.group(1), key.group(1)


def fetch_routes(url, key):
    req = urllib.request.Request(
        f"{url}/rest/v1/routes?select=id,scripts",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    apply = "--apply" in sys.argv
    url, key = cloud_creds()
    cloud = {r["id"]: (r.get("scripts") or {}) for r in fetch_routes(url, key)}

    doc = json.loads(ROUTES.read_text(encoding="utf-8"))
    changed = []
    for route in doc.get("routes", []):
        rid = route.get("id")
        new = cloud.get(rid)
        if new is None:
            continue                      # recorrido que no está en la nube: se deja
        old = route.get("scripts") or {}
        if old == new:
            continue
        # Un recorrido con guiones en el archivo y NINGUNO en la nube casi
        # siempre significa que la consulta trajo menos de lo que hay (permisos,
        # fila nueva), no que se borraron. No se vacía nunca en silencio.
        if old and not new:
            print(f"  ! {rid}: la nube no trae guiones y el archivo tiene {len(old)} — se conserva el archivo")
            continue
        changed.append((rid, len(old), len(new)))
        if apply:
            route["scripts"] = new

    if not changed:
        print("Sin cambios: los guiones empaquetados ya coinciden con la nube.")
        return
    for rid, a, b in changed:
        print(f"  {rid}: {a} -> {b} guion(es)")
    total = sum(b for _, _, b in changed)
    if apply:
        ROUTES.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\nEscrito {ROUTES.relative_to(ROOT)} — {total} guion(es) ahora viajan con la app.")
        print("Acuérdate de subir la VERSION del service worker antes de desplegar.")
    else:
        print(f"\n(dry-run) {total} guion(es) se empaquetarían. Corre con --apply para escribir.")


if __name__ == "__main__":
    main()
