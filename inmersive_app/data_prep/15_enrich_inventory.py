#!/usr/bin/env python3
"""
15_enrich_inventory.py — Reestructura species.json 1:1 con los censos de campo.

El GRUPO y el HÁBITO los fija el DOCUMENTO (no se adivina por especie):
  3_Listado Especies Cantares.xlsx      → flora / árbol
  6_ÁRBOLES Y ARBUSTOS NO REGISTRADOS   → flora / árbol   (no observados → status possible)
  inventaro aves reserva cantares.xlsx  → ave

Fusiona en species.json: a cada especie de esas fuentes le pone group+habit+source
(corrige las existentes, añade las nuevas). NO borra nada existente.

Lo que NO se puede parsear de forma confiable se FLAGEA (no se inventa):
  inventario_tangaras.pdf   (PDF escaneado, sin texto)
  4_Fichas Técnicas.pdf     (PDF de imágenes)
  2_Album_Flora_...docx     (mezcla árboles y flores → hábito ambiguo)
Los conflictos de nombre y las incoherencias de clase también se flagean.

Salida: species.json actualizado + info/censos_inventarios/inventario_FLAGS.txt
Uso:  python data_prep/15_enrich_inventory.py
"""

import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
SPECIES = ROOT / "app" / "public" / "data" / "species.json"
CENSOS = ROOT.parent / "info" / "censos_inventarios"
FLAGS = CENSOS / "inventario_FLAGS.txt"

BINOM = re.compile(r"^[A-Z][a-z]{2,}(?: [a-z][a-z\-]{2,})$")   # 'Genus species'
NON_TREE_CLASSES = {"Pteridopsida", "Equisetopsida", "Liliopsida"}  # helechos, cola de caballo, monocotiledóneas

# Fuentes confiables: (archivo, group, habit)
SOURCES = [
    ("3_Listado Especies Cantares.xlsx", "flora", "arbol"),
    ("6_ÁRBOLES Y ARBUSTOS NO REGISTRADOS.docx", "flora", "arbol"),
    ("inventaro aves reserva cantares.xlsx", "ave", None),
]
# No parseables → se listan para revisión manual del usuario.
FLAGGED_FILES = {
    "inventario_tangaras.pdf": "PDF escaneado (sin capa de texto) — extraer aves a mano o exportar a Excel.",
    "4_Fichas Técnicas.pdf": "PDF de imágenes (sin texto) — dar la lista de especies aparte.",
    "2_Album_Flora_CANTARES_Duque&Galeano_2021.docx": "Mezcla árboles y flores; hábito no es 1:1 → revisar y separar.",
}


def norm(s): return re.sub(r"\s+", " ", str(s)).strip().lower()
def binomial(s):
    t = re.sub(r"\s+", " ", str(s)).strip().split(" ")
    return f"{t[0]} {t[1]}" if len(t) >= 2 and BINOM.match(f"{t[0]} {t[1]}") else ""
def slug(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower() or "sp"


def parse_xlsx(path, sci_col, common_col=None, family_col=None, class_col=None):
    import pandas as pd
    xl = pd.ExcelFile(path)
    df = xl.parse(xl.sheet_names[0])
    # detecta columna de nombre científico si no se dio índice
    if isinstance(sci_col, str):
        col = sci_col
    else:  # header=None: busca la columna con más binomios
        df = xl.parse(xl.sheet_names[0], header=None)
        col = max(df.columns, key=lambda c: sum(1 for v in df[c].dropna().astype(str) if binomial(v)))
        common_col = col + 1 if (col + 1) in df.columns else None
    out = []
    for _, r in df.iterrows():
        sci = binomial(r.get(col, ""))
        if not sci:
            continue
        out.append({
            "sci": sci,
            "common": str(r.get(common_col, "") or "").strip() if common_col is not None else "",
            "family": str(r.get(family_col, "") or "").strip() if family_col is not None else "",
            "klass": str(r.get(class_col, "") or "").strip() if class_col is not None else "",
        })
    return out


def parse_docx_table(path):
    md = subprocess.run(["markitdown", path], capture_output=True, text=True,
                        encoding="utf-8", errors="ignore", timeout=120).stdout or ""
    out = []
    for line in md.splitlines():
        cells = [c.strip() for c in line.split("|")]
        sci = next((binomial(c) for c in cells if binomial(c)), "")
        if not sci:
            continue
        fam = next((c for c in cells if c.endswith("aceae")), "")
        out.append({"sci": sci, "common": "", "family": fam, "klass": ""})
    return out


def read_source(fname):
    p = CENSOS / fname
    if fname.startswith("3_Listado"):
        return parse_xlsx(p, "Especie", "Nombre común", "Familia", "Clase")
    if fname.startswith("inventaro aves"):
        return parse_xlsx(p, None)                     # header desordenado → autodetecta
    if fname.endswith(".docx"):
        return parse_docx_table(p)
    return []


def main():
    doc = json.loads(SPECIES.read_text(encoding="utf-8"))
    sp = doc["species"]
    by_sci = {norm(x["scientific_name"]): x for x in sp}
    used_ids = {x["id"] for x in sp}
    flags = []
    n_new = n_fixed = 0

    for fname, group, habit in SOURCES:
        rows = read_source(fname)
        if not rows:
            flags.append(f"[SIN DATOS] {fname}: no se extrajeron nombres — revisar.")
            continue
        for r in rows:
            k = norm(r["sci"])
            # aviso: clase que no es árbol pero la fuente es de árboles
            if habit == "arbol" and r["klass"] in NON_TREE_CLASSES:
                flags.append(f"[CLASE≠ÁRBOL] {r['sci']} ({r['klass']}) en {fname} — ¿de verdad árbol?")
            existing = by_sci.get(k)
            if existing:
                if existing.get("group") != group or (habit and existing.get("habit") != habit):
                    existing["group"] = group
                    if habit:
                        existing["habit"] = habit
                    existing.setdefault("source", fname)
                    n_fixed += 1
                # conflicto de género (posible errata/sinónimo con OTRA especie del inventario)
                continue
            genus = k.split(" ")[0]
            twins = sorted({x["scientific_name"] for kk, x in by_sci.items()
                            if kk.split(" ")[0] == genus and x.get("group") == group})
            if twins:
                flags.append(f"[CONFLICTO] {r['sci']} ({fname}) vs ya-en-inventario: {'; '.join(twins)}")
            sid, base, i = slug(r["common"] or r["sci"]), slug(r["common"] or r["sci"]), 1
            while sid in used_ids:
                i += 1; sid = f"{base}-{i}"
            used_ids.add(sid)
            entry = {
                "id": sid, "group": group, "status": "possible" if "NO REGISTRAD" in fname.upper() else "documented",
                "scientific_name": r["sci"], "common_name": r["common"] or r["sci"],
                "family": r["family"], "flagship": False,
                "id_tool": "plantnet" if group == "flora" else "merlin",
                "zones": [], "photo": None, "notes": "", "source": fname,
            }
            if habit:
                entry["habit"] = habit
            sp.append(entry); by_sci[k] = entry
            n_new += 1

    for fname, why in FLAGGED_FILES.items():
        flags.append(f"[MANUAL] {fname}: {why}")

    flags = list(dict.fromkeys(flags))   # dedupe conservando orden
    assert all(x.get("group") and x.get("scientific_name") for x in sp), "entrada sin group/sci"
    SPECIES.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    FLAGS.write_text("FLAGS del inventario — revisar y corregir a mano:\n\n" + "\n".join(flags) + "\n",
                     encoding="utf-8")

    from collections import Counter
    g = Counter(x["group"] for x in sp)
    hab = Counter(x.get("habit", "—") for x in sp if x["group"] == "flora")
    print("Reestructuración del inventario (species.json)")
    print(f"  Total ahora: {len(sp)}  | por grupo: {dict(g)}")
    print(f"  Flora por hábito: {dict(hab)}")
    print(f"  Nuevas añadidas: {n_new}  | grupo/hábito corregidos: {n_fixed}")
    print(f"  🚩 Flags para ti: {len(flags)}  → {FLAGS.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
