#!/usr/bin/env python3
"""
27_photo_points.py — Atributo `punto` de cada foto del archivo, derivado del GPS.

La mitad que faltaba de `docs/PLAN_FOTOS_CLASIFICACION.md`: «el punto es un
ATRIBUTO de la foto, no una carpeta». Una foto vive en una sola carpeta (su
categoría) y además puede pertenecer a un punto del mapa. Sin esto no existe
verdad de campo a nivel de punto: el catálogo tiene 0 de 3.936 entradas con
punto asignado.

La verdad de campo son los waypoints de la app (`waypoints.geojson` +
`trees.geojson`), no la foto: si el GPS EXIF cae a menos de un radio estricto de
un waypoint, ese es su punto; si no, `null`. Nunca mueve ni renombra un archivo.

**Correr `survey` PRIMERO.** Si pocas fotos traen GPS, todo lo demás sobra: los
móviles guardan coordenadas sólo si el permiso de ubicación estaba activo, y las
exportaciones de WhatsApp llegan siempre sin EXIF.

Uso:
  python data_prep/27_photo_points.py survey            # ¿cuántas traen GPS?
  python data_prep/27_photo_points.py assign            # manifiesto, no escribe
  python data_prep/27_photo_points.py assign --apply    # escribe `punto` en el catálogo
  python data_prep/27_photo_points.py assign --rollback # borra sólo lo que puso
  python data_prep/27_photo_points.py selftest          # sin fotos ni red
"""

import argparse
import json
import math
import sys
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
DATA = ROOT / "app" / "public" / "data"
MANIFEST = WORK / "photo_points_manifest.json"

RADIUS_M = 20.0        # radio estricto: un punto a 20 m es "ese punto"; a 50 no
SOURCE_TAG = "exif-gps"
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic"}


# ------------------------------------------------------------------ puras
def haversine(a, b):
    """Metros entre dos (lng, lat). Suficiente a esta escala: la reserva mide
    cientos de metros, donde la diferencia con una geodésica es milimétrica."""
    R = 6371000.0
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * R * math.asin(min(1.0, math.sqrt(h)))


def dms_to_deg(dms, ref):
    """EXIF guarda grados/minutos/segundos como racionales, y el hemisferio en un
    campo aparte. Sin aplicar `ref`, media Colombia acaba en el hemisferio norte."""
    d, m, s = (float(x) for x in dms)
    deg = d + m / 60.0 + s / 3600.0
    return -deg if str(ref).upper() in ("S", "W") else deg


def nearest_point(coord, waypoints, radius_m=RADIUS_M):
    """(id, metros) del waypoint más cercano dentro del radio, o (None, dist).
    Devuelve la distancia incluso cuando no asigna: saber que el más cercano
    estaba a 23 m es lo que dice si el radio está bien elegido."""
    best, best_d = None, float("inf")
    for wid, wcoord in waypoints:
        d = haversine(coord, wcoord)
        if d < best_d:
            best, best_d = wid, d
    return (best, best_d) if best_d <= radius_m else (None, best_d)


# ------------------------------------------------------------------ E/S
def load_waypoints():
    """[(id, (lng, lat))] de los puntos curados + el inventario de árboles."""
    out = []
    for name in ("waypoints.geojson", "trees.geojson"):
        f = DATA / name
        if not f.exists():
            continue
        for ft in json.loads(f.read_text(encoding="utf-8")).get("features", []):
            g, p = ft.get("geometry") or {}, ft.get("properties") or {}
            if g.get("type") == "Point" and p.get("id"):
                out.append((p["id"], tuple(g["coordinates"][:2])))
    return out


def exif_gps(path):
    """(lng, lat) del EXIF, o None. Nunca lanza: en un archivo de miles de fotos
    hay JPEG truncados y formatos raros, y uno no debe tumbar la pasada."""
    try:
        from PIL import Image
        from PIL.ExifTags import GPSTAGS, TAGS
        img = Image.open(path)
        raw = img.getexif()
        if not raw:
            return None
        gps_ifd = None
        for tag, val in raw.items():
            if TAGS.get(tag) == "GPSInfo":
                gps_ifd = raw.get_ifd(tag)
                break
        if not gps_ifd:
            return None
        g = {GPSTAGS.get(k, k): v for k, v in gps_ifd.items()}
        if not all(k in g for k in ("GPSLatitude", "GPSLongitude")):
            return None
        lat = dms_to_deg(g["GPSLatitude"], g.get("GPSLatitudeRef", "N"))
        lng = dms_to_deg(g["GPSLongitude"], g.get("GPSLongitudeRef", "E"))
        if lat == 0 and lng == 0:
            return None          # 0,0 es "sin fijo", no la isla Null
        return (lng, lat)
    except Exception:
        return None


def iter_photos(items, base, limit=None):
    n = 0
    for it in items:
        if it.get("kind") == "video":
            continue
        src = base / it["file"]
        if src.suffix.lower() not in IMG_EXT or not src.exists():
            continue
        yield it, src
        n += 1
        if limit and n >= limit:
            return


# ------------------------------------------------------------------ comandos
def cmd_survey(args):
    doc = json.loads(CATALOG.read_text(encoding="utf-8"))
    base, items = Path(doc["base"]), doc["items"]
    wps = load_waypoints()
    print(f"waypoints de referencia: {len(wps)}")
    print(f"fotos en el catálogo: {sum(1 for i in items if i.get('kind') != 'video')}")
    print(f"leyendo EXIF (límite {args.limit})…\n")

    stats = Counter()
    dists = []
    for it, src in iter_photos(items, base, args.limit):
        stats["leídas"] += 1
        c = exif_gps(src)
        if not c:
            stats["sin GPS"] += 1
            continue
        stats["con GPS"] += 1
        pid, d = nearest_point(c, wps)
        dists.append(d)
        stats["dentro del radio" if pid else "con GPS pero lejos"] += 1
        if stats["leídas"] % 200 == 0:
            print(f"  {stats['leídas']}…", flush=True)

    print(f"\n{'='*56}")
    for k, v in stats.most_common():
        print(f"  {k:24s} {v:5d}  ({v/max(1,stats['leídas']):.1%})")
    if dists:
        dists.sort()
        print(f"\n  distancia al waypoint más cercano (n={len(dists)}):")
        for q, lbl in ((0.5, "mediana"), (0.75, "p75"), (0.9, "p90")):
            print(f"    {lbl:8s} {dists[int(q * (len(dists) - 1))]:8.0f} m")
        print(f"    mínima  {dists[0]:8.0f} m")
    if not stats["con GPS"]:
        print("\n⚠ Ninguna foto trae GPS. El atributo `punto` no se puede derivar")
        print("  del EXIF: habría que asignarlo a mano o desde la app (que sí")
        print("  guarda lat/lng en `media`, migración 23).")


def cmd_assign(args):
    doc = json.loads(CATALOG.read_text(encoding="utf-8"))
    base, items = Path(doc["base"]), doc["items"]

    if args.rollback:
        n = 0
        for it in items:
            if it.get("punto_source") == SOURCE_TAG:
                it.pop("punto", None); it.pop("punto_source", None); it.pop("punto_m", None)
                n += 1
        CATALOG.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"↩ borrado el atributo `punto` de {n} entradas")
        return

    wps = load_waypoints()
    results, stats = [], Counter()
    for it, src in iter_photos(items, base, args.limit):
        c = exif_gps(src)
        if not c:
            stats["sin GPS"] += 1
            continue
        pid, d = nearest_point(c, wps)
        if not pid:
            stats["lejos de todo punto"] += 1
            continue
        stats["asignadas"] += 1
        results.append({"key": it["key"], "file": it["file"], "punto": pid, "m": round(d, 1)})

    MANIFEST.write_text(json.dumps({"n": len(results), "radius_m": RADIUS_M, "results": results},
                                   ensure_ascii=False, indent=1), encoding="utf-8")
    for k, v in stats.most_common():
        print(f"  {k:24s} {v}")
    print(f"\n✓ manifiesto → {MANIFEST}")
    if not args.apply:
        print("(manifiesto solamente — usa --apply para escribir el catálogo)")
        return
    by_key = {r["key"]: r for r in results}
    for it in items:
        r = by_key.get(it["key"])
        if r:
            it["punto"] = r["punto"]; it["punto_m"] = r["m"]; it["punto_source"] = SOURCE_TAG
    CATALOG.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"✓ {len(results)} entradas con `punto` (deshaz con --rollback)")


def cmd_selftest(args):
    # ~111 m por grado de latitud: dos puntos a 0.001° están a ~111 m.
    d = haversine((-75.5, 5.0), (-75.5, 5.001))
    assert 110 < d < 112, d
    assert haversine((-75.5, 5.0), (-75.5, 5.0)) == 0

    # El hemisferio va en `ref`: sin aplicarlo, Colombia (W) sale en Asia.
    assert dms_to_deg((5, 4, 30), "N") == 5 + 4 / 60 + 30 / 3600
    assert dms_to_deg((75, 30, 0), "W") == -(75 + 30 / 60)
    assert dms_to_deg((5, 0, 0), "S") == -5

    wps = [("punto_a", (-75.5000, 5.0000)), ("punto_b", (-75.5100, 5.0100))]
    pid, d = nearest_point((-75.50005, 5.00005), wps)
    assert pid == "punto_a" and d < 10, (pid, d)
    # Fuera del radio no se asigna, pero SÍ se informa la distancia: es lo que
    # dice si el radio de 20 m está bien elegido o hay que moverlo.
    pid, d = nearest_point((-75.5050, 5.0050), wps)
    assert pid is None and d > 20, (pid, d)
    print("selftest 27_photo_points: 7/7 OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    for name, fn, helptxt in (("survey", cmd_survey, "¿cuántas fotos traen GPS?"),
                              ("assign", cmd_assign, "deriva el atributo `punto`"),
                              ("selftest", cmd_selftest, "lógica pura, sin fotos")):
        sp = sub.add_parser(name, help=helptxt)
        sp.add_argument("--limit", type=int, default=None)
        if name == "assign":
            sp.add_argument("--apply", action="store_true")
            sp.add_argument("--rollback", action="store_true")
        sp.set_defaults(fn=fn)
    args = ap.parse_args()
    if not args.cmd:
        ap.print_help(); sys.exit(0)
    args.fn(args)


if __name__ == "__main__":
    main()
