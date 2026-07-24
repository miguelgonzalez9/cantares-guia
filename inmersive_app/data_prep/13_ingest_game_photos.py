#!/usr/bin/env python3
"""
13_ingest_game_photos.py — Flujo de VUELTA del Sistema de Información Cantares.

Las fotos que los visitantes toman en el juego («Expedición Cantares») viven en
el navegador (IndexedDB). El admin las respalda con el botón «Exportar fotos de
campo» de la app, que descarga un JSON `cantares_campo_*.json` con los
avistamientos + las fotos embebidas (base64). Este script las trae de vuelta al
sistema local (Dropbox):

  1. Lee los JSON que dejes en  inputs/photos/field/_incoming/
  2. Guarda cada foto en        inputs/photos/field/<species_id | _sin_identificar>/
  3. Acumula los avistamientos en  info/censos_inventarios/avistamientos_juego.csv
     (Darwin Core simplificado; deduplica por occurrenceID)
  4. Mueve el JSON procesado a   inputs/photos/field/_procesados/

Así el inventario ciudadano del juego se integra con el resto de la información.

Uso:  python data_prep/13_ingest_game_photos.py
"""

import base64
import csv
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]                 # inmersive_app/
FIELD = ROOT / "inputs" / "photos" / "field"
INCOMING = FIELD / "_incoming"
PROCESSED = FIELD / "_procesados"
CSV_OUT = ROOT.parent / "info" / "censos_inventarios" / "avistamientos_juego.csv"

CSV_COLS = ["occurrenceID", "eventDate", "recordedBy", "scientificName", "vernacularName",
            "group", "decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters",
            "kind", "gamePoints", "photo_file"]


def load_existing_ids():
    if not CSV_OUT.exists():
        return set(), []
    rows = list(csv.DictReader(CSV_OUT.open(encoding="utf-8")))
    return {r["occurrenceID"] for r in rows}, rows


def decode_photo(b64, dest: Path):
    if not b64:
        return False
    if "," in b64:
        b64 = b64.split(",", 1)[1]        # quita el prefijo data:image/…;base64,
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(base64.b64decode(b64))
        return True
    except Exception:
        return False


def main():
    for d in (INCOMING, PROCESSED):
        d.mkdir(parents=True, exist_ok=True)
    CSV_OUT.parent.mkdir(parents=True, exist_ok=True)

    seen, existing_rows = load_existing_ids()
    new_rows = []
    n_photos = 0
    files = sorted(INCOMING.glob("*.json"))
    if not files:
        print(f"Sin exportaciones nuevas en {INCOMING.relative_to(ROOT.parent)}. Nada que ingerir.")
        return

    for jf in files:
        try:
            doc = json.loads(jf.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"⚠️  {jf.name}: no se pudo leer ({e}) — omitido")
            continue
        obs = doc.get("observations") or doc.get("occurrences") or []
        for o in obs:
            oid = f"cantares-campo:{o.get('id') or o.get('occurrenceID') or ''}"
            if not oid or oid in seen:
                continue
            seen.add(oid)
            sid = o.get("speciesId") or "_sin_identificar"
            photo_file = ""
            b64 = o.get("photo_b64") or o.get("photo")
            if b64:
                dest = FIELD / sid / f"{(o.get('id') or 'obs')}.jpg"
                if decode_photo(b64, dest):
                    photo_file = str(dest.relative_to(ROOT.parent)).replace("\\", "/")
                    n_photos += 1
            new_rows.append({
                "occurrenceID": oid,
                "eventDate": o.get("time") or o.get("eventDate") or "",
                "recordedBy": o.get("player") or o.get("recordedBy") or "",
                "scientificName": o.get("sci") or o.get("scientificName") or "",
                "vernacularName": o.get("common") or o.get("vernacularName") or "",
                "group": o.get("group") or "",
                "decimalLatitude": o.get("lat") if o.get("lat") is not None else "",
                "decimalLongitude": o.get("lon") if o.get("lon") is not None else "",
                "coordinateUncertaintyInMeters": o.get("acc") if o.get("acc") is not None else "",
                "kind": o.get("kind") or "capture",
                "gamePoints": o.get("points") if o.get("points") is not None else "",
                "photo_file": photo_file,
            })
        shutil.move(str(jf), str(PROCESSED / jf.name))

    # reescribe el CSV acumulado (existentes + nuevos)
    all_rows = existing_rows + new_rows
    with CSV_OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLS)
        w.writeheader()
        for r in all_rows:
            w.writerow({k: r.get(k, "") for k in CSV_COLS})

    print("Flujo de vuelta — fotos del juego")
    print(f"  Exportaciones procesadas: {len(files)}")
    print(f"  Avistamientos nuevos: {len(new_rows)} (total acumulado: {len(all_rows)})")
    print(f"  Fotos guardadas: {n_photos} en inputs/photos/field/<especie>/")
    print(f"  Inventario: {CSV_OUT.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
