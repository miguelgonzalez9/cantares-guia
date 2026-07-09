#!/usr/bin/env python
"""07_pdf_to_content.py
Adapt inputs/maps/ortofoto_caminos.pdf into app content:
  - render the annotated trail map to a PNG (reference overlay)
  - build routes.json (the 6 real senderos) and waypoints.geojson (real POIs)

POI positions are georeferenced APPROXIMATELY by an affine map from the PDF
label layout to the reserve bounding box (from boundary.geojson). They are
flagged approx=true and must be replaced by real GPS points.
"""
import json, fitz
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PDF = ROOT / "inputs/maps/ortofoto_caminos.pdf"
OUTD = ROOT / "app/public/data"
IMGD = ROOT / "app/public/img"
IMGD.mkdir(parents=True, exist_ok=True)

# --- reserve bbox from the processed boundary ---
bnd = json.loads((OUTD / "boundary.geojson").read_text(encoding="utf-8"))
xs, ys = [], []
def walk(c):
    if isinstance(c[0], (int, float)):
        xs.append(c[0]); ys.append(c[1])
    else:
        for x in c: walk(x)
for f in bnd["features"]:
    walk(f["geometry"]["coordinates"])
LON0, LON1 = min(xs), max(xs)
LAT0, LAT1 = min(ys), max(ys)

doc = fitz.open(PDF)
page = doc[0]

# --- render annotated map to PNG ---
pix = page.get_pixmap(matrix=fitz.Matrix(2.1, 2.1))  # ~150 dpi
png_path = IMGD / "mapa_senderos.png"
pix.save(png_path)
print("wrote", png_path, pix.width, "x", pix.height)

# --- collect label centers (PDF points) ---
labels = {}
for b in page.get_text("dict")["blocks"]:
    for l in b.get("lines", []):
        txt = " ".join(s["text"] for s in l["spans"]).strip()
        if not txt:
            continue
        x0, y0, x1, y1 = l["bbox"]
        labels.setdefault(txt, ((x0 + x1) / 2, (y0 + y1) / 2))

# affine: PDF label extent -> reserve bbox (y flipped). Approximate.
PX0, PX1 = 79, 585
PY0, PY1 = 195, 452
def to_lonlat(px, py):
    lon = LON0 + (px - PX0) / (PX1 - PX0) * (LON1 - LON0)
    lat = LAT1 - (py - PY0) / (PY1 - PY0) * (LAT1 - LAT0)
    # clamp inside reserve so nothing lands outside the boundary box
    lon = min(max(lon, LON0), LON1)
    lat = min(max(lat, LAT0), LAT1)
    return round(lon, 6), round(lat, 6)

# Explicit PDF-point positions for labels the fuzzy matcher can't disambiguate
# (e.g. the three miradores all share the word "mirador"). Taken from the
# extracted label centers.
OVERRIDE = {
    "Mirador 1": (334, 198),
    "Mirador 2": (233, 251),
    "Mirador 3 — Ciudad de Manizales": (79, 324),
}

STOP = {"de", "los", "las", "la", "el", "y", "del", "sendero"}
def pos(label):
    if label in OVERRIDE:
        return to_lonlat(*OVERRIDE[label])
    # Match on shared significant words; average the centers of ALL matching
    # label lines (handles multi-line PDF labels like "Jardín de los\nColibríes").
    want = {w for w in label.lower().replace("—", " ").split() if w not in STOP and len(w) > 2}
    hits = [v for k, v in labels.items()
            if want & {w for w in k.lower().split() if w not in STOP}]
    if hits:
        return to_lonlat(sum(h[0] for h in hits) / len(hits),
                         sum(h[1] for h in hits) / len(hits))
    return to_lonlat((PX0 + PX1) / 2, (PY0 + PY1) / 2)

# --- the 6 real senderos (routes) ---
routes = [
    {"id": "aguas", "name": "Sendero Las Aguas", "name_en": "Waters Trail", "emoji": "💧", "color": "#2b8cbe",
     "theme": "agua", "summary": "Quebradas, nacimientos y el bosque ribereño que regula el agua de la cuenca del Río Blanco.",
     "summary_en": "Creeks, springs and the riparian forest that regulates water in the Río Blanco watershed."},
    {"id": "cascadas", "name": "Sendero Las Cascadas", "name_en": "Waterfalls Trail", "emoji": "🌊", "color": "#1f6f8b",
     "theme": "agua", "summary": "Baja hasta las cascadas por bosque húmedo de fuerte pendiente.",
     "summary_en": "Descends to the waterfalls through steep humid forest."},
    {"id": "encenillos", "name": "Sendero Los Encenillos", "name_en": "Encenillos Trail", "emoji": "🌳", "color": "#238b45",
     "theme": "arboles", "summary": "Encenillos, robles y el bosque en restauración camino a la cabaña.",
     "summary_en": "Encenillo and oak trees and the restoring forest on the way to the cabin."},
    {"id": "helechos", "name": "Sendero de Helechos y Orquídeas", "name_en": "Ferns & Orchids Trail", "emoji": "🌿", "color": "#40916c",
     "theme": "arboles", "summary": "Helechos arbóreos y epífitas en las zonas de mayor humedad.",
     "summary_en": "Tree ferns and epiphytes in the most humid areas."},
    {"id": "tororoi", "name": "Sendero Tororoi", "name_en": "Tororoi Trail", "emoji": "🐦", "color": "#d94801",
     "theme": "aves", "summary": "Nombrado por el tororoi; buen sendero para aves de sotobosque. Trae Merlin.",
     "summary_en": "Named after the antpitta; great for understory birds. Bring Merlin."},
    {"id": "cabana", "name": "Sendero La Cabaña", "name_en": "Cabin Trail", "emoji": "🏚️", "color": "#8d6e63",
     "theme": "arboles", "summary": "Conecta la portada, la cabaña y los miradores.",
     "summary_en": "Connects the entrance, the cabin and the lookouts."},
]

# --- POIs (waypoints): real names from the PDF ---
# (search_name, theme, title_es, title_en, desc_es, desc_en, species)
POIS = [
    ("Portada", "info", "Entrada", "Entrance",
     "Portada e inicio de los recorridos de la reserva.", "Gateway and start of the reserve trails.", []),
    ("Casa", "info", "Casa", "House",
     "Casa principal del predio, en la zona de uso intensivo.", "Main house of the property, in the intensive-use zone.", []),
    ("Cabaña", "info", "La Cabaña", "The Cabin",
     "Cabaña de descanso; punto de encuentro de varios senderos.", "Rest cabin; meeting point of several trails.", []),
    ("Vivero", "restauracion", "Vivero", "Nursery",
     "Vivero donde se propagan las especies nativas para la restauración.", "Nursery where native species are propagated for restoration.", ["arboloco","encenillo","drago"]),
    ("Arboretum", "arboles", "Arboretum", "Arboretum",
     "Colección de árboles nativos representativos del bosque montano.", "Collection of native trees representative of the montane forest.", ["roble","yarumo","cedro-negro"]),
    ("Bosque de los Sietecueros", "arboles", "Bosque de los Sietecueros", "Sietecueros Grove",
     "Rodal dominado por sietecueros (Tibouchina), llamativos por su flor morada.", "Stand dominated by sietecueros (Tibouchina), striking for their purple flowers.", []),
    ("Jardín de los Colibríes", "aves", "Jardín de los Colibríes", "Hummingbird Garden",
     "Jardín con flores que atraen colibríes; excelente para fotografía y observación.", "Flower garden that attracts hummingbirds; great for photography and watching.", ["barranquero"]),
    ("Nido del Aguila", "aves", "Nido del Águila", "Eagle's Nest",
     "Mirador alto asociado a aves rapaces.", "High lookout associated with birds of prey.", []),
    ("Cascadas", "agua", "Cascadas", "Waterfalls",
     "Saltos de agua en la red hídrica de la reserva.", "Waterfalls in the reserve's stream network.", ["helecho-arboreo"]),
    ("Mirador 1", "info", "Mirador 1", "Lookout 1",
     "Primer mirador del recorrido.", "First lookout on the route.", []),
    ("Mirador 2", "info", "Mirador 2", "Lookout 2",
     "Mirador intermedio sobre el mosaico de bosque y restauración.", "Mid lookout over the forest and restoration mosaic.", []),
    ("Mirador 3 — Ciudad de Manizales", "info", "Mirador 3 — Ciudad de Manizales", "Lookout 3 — Manizales City",
     "Mirador con vista a la ciudad de Manizales.", "Lookout with a view of the city of Manizales.", []),
]

features = []
for sname, theme, title, title_en, desc, desc_en, species in POIS:
    lon, lat = pos(sname)
    wid = (sname.lower().replace(" ", "-").replace("á","a").replace("í","i")
           .replace("ñ","n").replace("—","").replace("é","e").replace("ó","o"))
    features.append({
        "type": "Feature",
        "properties": {
            "id": wid, "name": title, "themes": [theme],
            "title": title, "title_en": title_en,
            "description": desc, "description_en": desc_en,
            "species_ids": species, "photo": None, "audio": None, "approx": True,
        },
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    })

(OUTD / "routes.json").write_text(json.dumps({
    "_meta": {"note": "Senderos reales tomados de ortofoto_caminos.pdf.",
              "themes": ["agua", "arboles", "aves", "restauracion"]},
    "routes": routes,
}, ensure_ascii=False, indent=2), encoding="utf-8")

(OUTD / "waypoints.geojson").write_text(json.dumps({
    "type": "FeatureCollection",
    "_meta": "POIs reales de ortofoto_caminos.pdf. Posiciones APROXIMADAS (afín desde el PDF) — reemplazar con GPS real.",
    "features": features,
}, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"wrote routes.json ({len(routes)} senderos) and waypoints.geojson ({len(features)} POIs)")
print("reserve bbox:", round(LON0,5), round(LAT0,5), round(LON1,5), round(LAT1,5))
