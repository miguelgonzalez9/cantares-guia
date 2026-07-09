#!/usr/bin/env python
"""09_trail_centerlines.py
Turn the trail FOOTPRINT polygon (caminos.geojson) into center-LINES the app can
draw, and tag each segment with the recorridos (routes) it belongs to, based on
nearby key points. Output: app/public/data/trails.geojson (LineStrings).

These centerlines are AUTO-derived and approximate — the owner refines/replaces
them in QGIS (see docs/QGIS_GUIA.md). Direction = coordinate order of each line.
"""
import json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from skimage.morphology import skeletonize
import sknw
from shapely.geometry import shape, LineString

ROOT = Path(__file__).resolve().parents[1]
OUTD = ROOT / "app/public/data"
caminos = json.loads((OUTD / "caminos.geojson").read_text(encoding="utf-8"))
wps = json.loads((OUTD / "waypoints.geojson").read_text(encoding="utf-8"))

geom = shape(caminos["features"][0]["geometry"])
lon0, lat0, lon1, lat1 = geom.bounds
pad = 0.0004
lon0 -= pad; lat0 -= pad; lon1 += pad; lat1 += pad

# raster ~0.5 m/pixel
mid = (lat0 + lat1) / 2
W = int((lon1 - lon0) * 111320 * math.cos(math.radians(mid)) / 0.5)
H = int((lat1 - lat0) * 110540 / 0.5)
W, H = max(200, min(W, 3000)), max(200, min(H, 3000))

def to_px(lon, lat):
    return ((lon - lon0) / (lon1 - lon0) * W, (lat1 - lat) / (lat1 - lat0) * H)
def to_ll(x, y):
    return (lon0 + x / W * (lon1 - lon0), lat1 - y / H * (lat1 - lat0))

# rasterize polygon(s) to a binary mask
img = Image.new("1", (W, H), 0)
d = ImageDraw.Draw(img)
polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
for pg in polys:
    d.polygon([to_px(x, y) for x, y in pg.exterior.coords], fill=1)
    for ring in pg.interiors:
        d.polygon([to_px(x, y) for x, y in ring.coords], fill=0)
# uint8 + contiguous + Lee method: the Zhang method segfaults on Python 3.14 here.
mask = np.ascontiguousarray(np.array(img), dtype=np.uint8)
skel = skeletonize(mask, method='lee').astype(bool)
graph = sknw.build_sknw(skel)

# key points for route tagging
def haversine(a, b):
    R = 6371000; t = math.pi / 180
    dlat = (b[1]-a[1])*t; dlon = (b[0]-a[0])*t
    h = math.sin(dlat/2)**2 + math.cos(a[1]*t)*math.cos(b[1]*t)*math.sin(dlon/2)**2
    return 2*R*math.asin(math.sqrt(h))
kps = [(f["geometry"]["coordinates"], f["properties"].get("routes", []))
       for f in wps["features"] if f["properties"].get("routes")]

def routes_for(line_ll):
    rts = set()
    for pt, prts in kps:
        if any(haversine(v, pt) < 55 for v in line_ll):
            rts.update(prts)
    return sorted(rts)

features, tid = [], 0
for (s, e) in graph.edges():
    pts = graph[s][e]["pts"]          # pixel (row, col) path
    ll = [to_ll(c, r) for r, c in pts]  # note sknw pts are (row,col)=(y,x)
    if len(ll) < 2:
        continue
    line = LineString(ll).simplify(0.00002, preserve_topology=True)
    coords = [list(c) for c in line.coords]
    if len(coords) < 2:
        continue
    tid += 1
    features.append({
        "type": "Feature",
        "properties": {"id": f"t{tid}", "routes": routes_for(coords), "approx": True},
        "geometry": {"type": "LineString", "coordinates": [[round(x,6), round(y,6)] for x, y in coords]},
    })

(OUTD / "trails.geojson").write_text(json.dumps({
    "type": "FeatureCollection",
    "_meta": "Center-líneas auto-derivadas del footprint de caminos + etiqueta de recorrido por cercanía. APROXIMADO — refinar en QGIS.",
    "features": features,
}, ensure_ascii=False), encoding="utf-8")

tagged = sum(1 for f in features if f["properties"]["routes"])
print(f"raster {W}x{H} | {len(features)} trail segments ({tagged} route-tagged)")
