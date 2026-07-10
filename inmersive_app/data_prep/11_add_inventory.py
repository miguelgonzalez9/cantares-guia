#!/usr/bin/env python
"""11_add_inventory.py — grow the species inventory from the Cantares documents:
the tangara appendix (inventario_tangaras.pdf) and the interpretive script
(Guión interpretativo Cantares). Appends to species.json, de-duping by id and
scientific name. Adds an 'anfibio' group for the frog."""
import json, unicodedata
from pathlib import Path

P = Path(__file__).resolve().parents[1] / "app/public/data/species.json"

def slug(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return s.lower().replace(" ", "-").replace(".", "").replace("'", "")

# (group, scientific, common_es, common_en, family, flagship, status, notes)
NEW = [
    # --- Tángaras del apéndice (probabilidad de visita a comederos) ---
    ("ave", "Anisognathus somptuosus", "Tángara primavera", "Blue-winged Mountain-Tanager", "Thraupidae", True, "possible", "Visita comederos (prob. media)."),
    ("ave", "Chlorornis riefferii", "Tángara lorito", "Grass-green Tanager", "Thraupidae", False, "possible", "Visita comederos (prob. media-baja)."),
    ("ave", "Anisognathus lacrymosus", "Tángara lacrimosa", "Lacrimose Mountain-Tanager", "Thraupidae", False, "possible", "Visita comederos (prob. media-alta)."),
    ("ave", "Tangara nigroviridis", "Tángara de lentejuelas", "Beryl-spangled Tanager", "Thraupidae", False, "possible", "Visita comederos (prob. media)."),
    ("ave", "Tangara xanthocephala", "Tángara coronidorada", "Saffron-crowned Tanager", "Thraupidae", False, "possible", "Visita comederos (prob. media)."),
    ("ave", "Tangara labradorides", "Tángara verdiplata", "Metallic-green Tanager", "Thraupidae", False, "possible", "Visita comederos (prob. media-alta)."),
    ("ave", "Conirostrum albifrons", "Conirrostro coronado", "Capped Conebill", "Thraupidae", False, "possible", "Visita comederos (prob. alta-media)."),
    ("ave", "Dubusia taeniata", "Tángara diadema", "Buff-breasted Mountain-Tanager", "Thraupidae", False, "possible", "Prob. media-alta; puede atraerse con playback."),
    ("ave", "Sporathraupis cyanocephala", "Azulejo montañero", "Blue-capped Tanager", "Thraupidae", True, "possible", "Visita comederos (prob. alta)."),
    ("ave", "Tangara vassorii", "Tángara azulinegra", "Blue-and-black Tanager", "Thraupidae", False, "possible", "Visita comederos (prob. media)."),
    ("ave", "Zonotrichia capensis", "Copetón", "Rufous-collared Sparrow", "Passerellidae", False, "possible", "Visita comederos (prob. alta)."),
    # --- Aves emblemáticas del guión ---
    ("ave", "Spizaetus isidori", "Águila crestada de montaña", "Black-and-chestnut Eagle", "Accipitridae", True, "documented", "Segunda águila más amenazada de los Andes; observada casi a diario sobre las pendientes (corrientes térmicas). Objeto de conservación."),
    ("ave", "Odontophorus hyperythrus", "Perdiz colorada", "Chestnut Wood-Quail", "Odontophoridae", True, "documented", "Endémica y amenazada; canto al amanecer. Especie objeto de conservación."),
    ("ave", "Leptosittaca branickii", "Lora draguera", "Golden-plumed Parakeet", "Psittacidae", True, "documented", "Migra según la semilla del drago; mayor actividad en nov–dic."),
    ("ave", "Nothocercus julius", "Tinamú leonado", "Tawny-breasted Tinamou", "Tinamidae", True, "documented", "Terrestre, difícil de observar; vocaliza al amanecer."),
    ("ave", "Andigena nigrirostris", "Tucán pechiazul / Terlaque", "Black-billed Mountain-Toucan", "Ramphastidae", True, "documented", "Dispersor de semillas del bosque montano."),
    ("ave", "Amazona mercenarius", "Lora andina", "Scaly-naped Parrot", "Psittacidae", False, "documented", "Frugívora; dispersora de semillas."),
    ("ave", "Chamaepetes goudotii", "Pava maraquera", "Sickle-winged Guan", "Cracidae", False, "documented", "Ave frugívora dispersora de semillas."),
    ("ave", "Chaetocercus mulsant", "Rumbito pechiblanco", "White-bellied Woodstar", "Trochilidae", True, "documented", "El colibrí más pequeño de Colombia; entre 16+ especies de colibríes del jardín."),
    # --- Mamíferos ---
    ("mamifero", "Puma concolor", "Puma / León de montaña", "Puma", "Felidae", True, "documented", "Registrado por cámaras trampa; comparte el tope de la red trófica con el águila crestada."),
    ("mamifero", "Dasypus novemcinctus", "Armadillo", "Nine-banded Armadillo", "Dasypodidae", False, "documented", "Recicla nutrientes del suelo al remover tierra buscando invertebrados."),
    ("mamifero", "Potos flavus", "Perro de monte / Martucha", "Kinkajou", "Procyonidae", False, "documented", "Nocturno, arborícola; dispersor de semillas."),
    # --- Anfibios ---
    ("anfibio", "Hyloscirtus larinopygion", "Rana de chocolate", "Cordillera Central Tree Frog", "Hylidae", True, "documented", "Rana de torrente asociada a las peñas de las cascadas; indicadora de agua limpia."),
    # --- Flora emblemática del guión ---
    ("flora", "Tibouchina lepidota", "Sietecueros", "Andean Princess-flower", "Melastomataceae", True, "documented", "Flor morada llamativa; también citado como Andesanthus lepidotus."),
    ("flora", "Retrophyllum rospigliosii", "Pino colombiano / Pino romerón", "Colombian Mountain Pine", "Podocarpaceae", True, "documented", "Conífera nativa sembrada en la restauración; amenazada."),
    ("flora", "Ceroxylon quindiuense", "Palma de cera del Quindío", "Quindío Wax Palm", "Arecaceae", True, "documented", "Árbol nacional de Colombia; sembrada en la restauración."),
    ("flora", "Anthurium caramantae", "Anturio negro", "Black Anthurium", "Araceae", True, "documented", "Flor emblema de Manizales."),
    ("flora", "Oncidium luteopurpureum", "Orquídea amarillo-púrpura", "Yellow-purple Oncidium", "Orchidaceae", True, "documented", "Orquídea endémica de Colombia, flor emblema de Bogotá."),
    ("flora", "Oreopanax sp.", "Mano de oso", "Oreopanax", "Araliaceae", False, "documented", "Sembrado en la restauración."),
    ("flora", "Chusquea sp.", "Chusque", "Andean Bamboo", "Poaceae", False, "documented", "Bambú andino; hábitat de rata espinosa y arrendajo; alto valor en captación de agua."),
]

doc = json.loads(P.read_text(encoding="utf-8"))
by_id = {s["id"] for s in doc["species"]}
by_sci = {s["scientific_name"].lower() for s in doc["species"]}
id_tool = {"flora": "plantnet", "ave": "merlin", "mamifero": "wildlife_insights", "anfibio": "inaturalist"}

added = 0
for group, sci, es, en, fam, flag, status, notes in NEW:
    if sci.lower() in by_sci:
        continue
    sid = slug(es.split(" / ")[0])
    base = sid; n = 2
    while sid in by_id:
        sid = f"{base}-{n}"; n += 1
    doc["species"].append({
        "id": sid, "group": group, "status": status, "scientific_name": sci,
        "common_name": es, "common_name_en": en, "family": fam, "flagship": flag,
        "id_tool": id_tool[group], "zones": [], "photo": None, "notes": notes,
    })
    by_id.add(sid); by_sci.add(sci.lower()); added += 1

# refresh counts
from collections import Counter
c = Counter(s["group"] for s in doc["species"])
doc["_meta"]["counts"] = dict(c)
doc["_meta"]["source"] = doc["_meta"].get("source", "") + " + Guión interpretativo + Apéndice tángaras"
P.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"añadidas {added} especies; total {len(doc['species'])}; por grupo {dict(c)}")
