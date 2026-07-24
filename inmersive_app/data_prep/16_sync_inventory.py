#!/usr/bin/env python3
"""
16_sync_inventory.py — El Excel maestro es el GROUND TRUTH del inventario.

  export:  species.json  →  info/censos_inventarios/inventario_maestro.xlsx
  import:  inventario_maestro.xlsx  →  species.json   (aplica tus cambios/añadidos)

Añadir una especie = añadir una fila en el Excel (basta scientific_name + group +
habit) y correr `import`. El id se genera solo si lo dejas vacío. Round-trip sin
pérdida: cada campo de species.json es una columna.

Uso:  python data_prep/16_sync_inventory.py export
      python data_prep/16_sync_inventory.py import
Requiere: pandas + openpyxl.
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
SPECIES = ROOT / "app" / "public" / "data" / "species.json"
XLSX = ROOT.parent / "info" / "censos_inventarios" / "inventario_maestro.xlsx"

# Orden de columnas (todas las claves que usa la app). group y habit al frente.
COLS = ["id", "group", "habit", "status", "scientific_name", "common_name",
        "common_name_en", "family", "flagship", "id_tool", "zones", "photo",
        "source", "notes"]
GROUPS = {"flora", "ave", "mamifero", "anfibio", "insecto", "reptil"}


def slug(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower() or "sp"


def export():
    import pandas as pd
    sp = json.loads(SPECIES.read_text(encoding="utf-8"))["species"]
    rows = []
    for x in sp:
        r = {c: x.get(c, "") for c in COLS}
        r["zones"] = ",".join(x.get("zones", []) or [])
        rows.append(r)
    df = pd.DataFrame(rows, columns=COLS).sort_values(["group", "habit", "scientific_name"])
    with pd.ExcelWriter(XLSX, engine="openpyxl") as w:
        df.to_excel(w, index=False, sheet_name="inventario")
        pd.DataFrame({"group válidos": sorted(GROUPS),
                      "habit (flora)": ["arbol", "flor", "planta", "(vacío)"] + [""] * (len(GROUPS) - 4)
                      }).to_excel(w, index=False, sheet_name="valores")
    print(f"export: {len(sp)} especies → {XLSX.relative_to(ROOT.parent)}")


def import_():
    import pandas as pd
    df = pd.read_excel(XLSX, sheet_name="inventario").fillna("")
    seen, out = set(), []
    for _, r in df.iterrows():
        sci = str(r.get("scientific_name", "")).strip()
        group = str(r.get("group", "")).strip()
        if not sci or group not in GROUPS:
            continue                         # fila vacía/ inválida → se ignora (no se inventa)
        common = str(r.get("common_name", "")).strip()
        if common.lower() == "nan":
            common = ""
        sid = str(r.get("id", "")).strip()
        if sid.lower().startswith("nan") or not sid:
            sid = slug(sci)                  # id estable desde el nombre científico
        b, i = sid, 1
        while sid in seen:
            i += 1; sid = f"{b}-{i}"
        seen.add(sid)
        e = {"id": sid, "group": group,
             "status": str(r.get("status", "") or "documented").strip(),
             "scientific_name": sci,
             "common_name": common or sci,
             "family": str(r.get("family", "")).strip(),
             "flagship": str(r.get("flagship", "")).strip().lower() in ("true", "1", "si", "sí", "verdadero"),
             "id_tool": str(r.get("id_tool", "") or ("plantnet" if group == "flora" else "merlin")).strip(),
             "zones": [z for z in str(r.get("zones", "")).split(",") if z.strip()],
             "photo": (str(r.get("photo", "")).strip() or None),
             "notes": str(r.get("notes", "")).strip()}
        for opt in ("habit", "common_name_en", "source"):
            v = str(r.get(opt, "")).strip()
            if v:
                e[opt] = v
        out.append(e)
    assert out, "el Excel no produjo especies — ¿hoja 'inventario' vacía?"
    doc = json.loads(SPECIES.read_text(encoding="utf-8"))
    doc["species"] = out
    SPECIES.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"import: {len(out)} especies del Excel → species.json")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "export"
    (export if cmd == "export" else import_)()
