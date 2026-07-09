#!/usr/bin/env python
"""08_add_species_en.py — add English common names (common_name_en) to species.json.
Only species with a well-established English name get the field; the app falls
back to the Spanish common name otherwise."""
import json
from pathlib import Path

P = Path(__file__).resolve().parents[1] / "app/public/data/species.json"
EN = {
    # flora
    "aliso": "Andean alder", "arboloco": "Daisy tree", "yarumo": "Trumpet tree (Cecropia)",
    "encenillo": "Encenillo", "drago": "Dragon's-blood tree", "roble": "Andean oak",
    "cinchona": "Quinine tree", "chaparro": "Sandpaper tree", "helecho-arboreo": "Tree fern",
    "anon-de-monte": "Wild soursop", "aguacatillo": "Wild avocado", "chocho": "Coral tree",
    "arrayan": "Myrtle", "higueron-tierra-fria": "Wild fig", "cacao-de-monte": "Wild cacao",
    "guamo": "Ice-cream bean", "cedro-negro": "Andean walnut", "cordoncillo": "Spiked pepper",
    "frutillo": "Turkey berry", "manzanillo": "Poison ash", "zurrumbo": "Jamaican nettletree",
    "pringamoso": "Stinging nettle tree", "pita": "Viburnum", "tachuelo": "Prickly ash",
    "palmicho": "Mountain palm",
    # birds
    "barranquero": "Andean Motmot", "reinita-tropical": "Canada Warbler",
    "carpintero-de-los-robles": "Acorn Woodpecker", "torcaza": "Eared Dove",
    "tangara-real": "Blue-necked Tanager", "azulejo-comun": "Blue-gray Tanager",
    "tangara-lacrada": "Bay-headed Tanager", "mirla": "Great Thrush",
    # mammals
    "tigrillo": "Oncilla", "zorro": "Crab-eating fox", "paca-de-montana": "Mountain paca",
    "guatin": "Agouti", "zarigueya": "White-eared opossum", "conejo": "Cottontail rabbit",
    "cusumbo": "Mountain coati", "ardilla": "Red-tailed squirrel",
}
doc = json.loads(P.read_text(encoding="utf-8"))
n = 0
for s in doc["species"]:
    if s["id"] in EN:
        s["common_name_en"] = EN[s["id"]]; n += 1
P.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"added common_name_en to {n}/{len(doc['species'])} species")
