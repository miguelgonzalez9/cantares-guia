#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
22_species_descriptions.py — enrich species.json with a technical `description`.

Two sources, both keyed by normalized scientific_name (the universal join key):

  1) AUTHORITATIVE (reviewed=True): the 2021 census ecology sheet
     `3_Listado Especies Cantares.xlsx` → sheet "Especies+Ecología y Morfología".
     Real botanical fact-sheets (morfología, hábitat, zona de vida, rango
     altitudinal, origen, usos, UICN). Composed into a multi-paragraph ES text.

  2) DRAFT (reviewed=False): `_enrich/descriptions_flagship.json` — hand/LLM-authored
     bilingual descriptions for flagship species the census doesn't cover. Flagged
     unreviewed so the owner can verify before trusting them.

Writes onto each matched species record: description, description_en,
description_source, description_reviewed, and iucn (badge code, ecology rows only).
Idempotent: skips records that already have a description unless --force.

Usage:
  python 22_species_descriptions.py            # apply both sources (fill only)
  python 22_species_descriptions.py --force    # overwrite existing descriptions
  python 22_species_descriptions.py --dry-run  # report, write nothing
"""
import argparse, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SPECIES = os.path.join(HERE, "..", "app", "public", "data", "species.json")
XLSX = os.environ.get("CANTARES_XLSX", os.path.join(
    HERE, "..", "..", "info", "ambiental", "censos_inventarios",
    "arboles_arbustos", "3_Listado Especies Cantares.xlsx"))
ECO_SHEET = "Especies+Ecología y Morfología"
FLAGSHIP_JSON = os.path.join(HERE, "_enrich", "descriptions_flagship.json")


def norm(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def clean(v):
    """Trim, collapse whitespace, drop pandas NaN / placeholder dashes."""
    s = re.sub(r"\s+", " ", str(v or "").strip())
    if s.lower() in ("", "nan", "-", "—", "n/a", "na"):
        return ""
    return s


def sentence(s):
    """Ensure a trailing period so composed clauses read cleanly."""
    s = clean(s)
    if s and s[-1] not in ".!?":
        s += "."
    return s


def iucn_code(estado):
    """'En Peligro (EN)' -> 'EN'. Falls back to '' if no parenthetical code."""
    m = re.search(r"\(([A-Z]{2,3})\)", clean(estado))
    return m.group(1) if m else ""


def compose_es(row):
    """Multi-paragraph Spanish technical description from an ecology row.
    Paragraphs separated by blank lines; the app splits on \\n\\n."""
    morf = sentence(row.get("Morfologia "))
    hab = sentence(row.get("Hábitat"))
    zona = sentence(row.get("Zona de vida o ecosistema"))
    rango = clean(row.get("Rango altitudinal"))
    origen = clean(row.get("Origen "))
    usos = clean(row.get("Usos"))
    estado = clean(row.get("Estado De Conservación (Categoría)"))

    paras = []
    if morf:
        paras.append(morf)
    # Ecology paragraph — labeled but plain (no markdown; app escapes HTML).
    eco = []
    if hab:
        eco.append(f"Hábitat: {hab}")
    if zona:
        eco.append(f"Zona de vida: {zona}")
    if rango:
        eco.append(f"Rango altitudinal: {rango}.")
    if origen:
        eco.append(f"Origen: {origen}.")
    if eco:
        paras.append(" ".join(eco))
    # Uses + conservation.
    tail = []
    if usos:
        tail.append(f"Usos: {usos}")
        if not usos.endswith("."):
            tail[-1] += "."
    if estado:
        tail.append(f"Estado de conservación (UICN): {estado}.")
    if tail:
        paras.append(" ".join(tail))
    text = "\n\n".join(paras).strip()
    text = re.sub(r"\.{2,}", ".", text)      # collapse ".." from fields already ending in "."
    text = re.sub(r" +([.,;])", r"\1", text)  # no space before punctuation
    return text


def load_species():
    with open(SPECIES, encoding="utf-8") as f:
        return json.load(f)


def apply_ecology(by_sci, force, dry):
    """Returns (matched, written, unmatched_sci_list)."""
    try:
        import pandas as pd
    except ImportError:
        print("  ! pandas not available — skipping ecology sheet", file=sys.stderr)
        return 0, 0, []
    if not os.path.exists(XLSX):
        print(f"  ! ecology xlsx not found: {XLSX}", file=sys.stderr)
        return 0, 0, []
    eco = pd.read_excel(XLSX, sheet_name=ECO_SHEET)
    matched = written = 0
    unmatched = []
    for _, row in eco.iterrows():
        sci = norm(row.get("Especie"))
        if not sci:
            continue
        sp = by_sci.get(sci)
        if not sp:
            unmatched.append(sci)
            continue
        matched += 1
        if sp.get("description") and not force:
            continue
        desc = compose_es(row)
        if not desc:
            continue
        if not dry:
            sp["description"] = desc
            sp["description_en"] = sp.get("description_en") or None  # ES fallback for now
            sp["description_source"] = "censo_2021"
            sp["description_reviewed"] = True
            code = iucn_code(row.get("Estado De Conservación (Categoría)"))
            if code:
                sp["iucn"] = code
        written += 1
    return matched, written, unmatched


def apply_flagship(by_sci, force, dry):
    """Hand/LLM-authored bilingual drafts. Returns (matched, written, missing)."""
    if not os.path.exists(FLAGSHIP_JSON):
        print(f"  · no flagship draft file ({FLAGSHIP_JSON}) — skipping")
        return 0, 0, []
    with open(FLAGSHIP_JSON, encoding="utf-8") as f:
        drafts = json.load(f)
    matched = written = 0
    missing = []
    for d in drafts:
        sci = norm(d.get("scientific_name"))
        sp = by_sci.get(sci)
        if not sp:
            missing.append(d.get("scientific_name"))
            continue
        matched += 1
        if sp.get("description") and not force:
            continue
        if not dry:
            sp["description"] = d["description"].strip()
            sp["description_en"] = (d.get("description_en") or "").strip() or None
            sp["description_source"] = "llm_draft"
            sp["description_reviewed"] = False
        written += 1
    return matched, written, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="overwrite existing descriptions")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    doc = load_species()
    sp = doc["species"]
    by_sci = {norm(s["scientific_name"]): s for s in sp}

    print(f"species.json: {len(sp)} records")
    print("· ecology sheet (authoritative, reviewed=True):")
    m, w, un = apply_ecology(by_sci, args.force, args.dry_run)
    print(f"    matched {m}, wrote {w}" + (f", unmatched sci: {un}" if un else ""))
    print("· flagship drafts (llm_draft, reviewed=False):")
    m2, w2, miss = apply_flagship(by_sci, args.force, args.dry_run)
    print(f"    matched {m2}, wrote {w2}" + (f", missing from species.json: {miss}" if miss else ""))

    have = sum(1 for s in sp if s.get("description"))
    print(f"total species with a description now: {have}/{len(sp)}")

    if args.dry_run:
        print("(dry-run — nothing written)")
        return
    if w + w2:
        with open(SPECIES, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        print(f"wrote {SPECIES}")
    else:
        print("no changes")


if __name__ == "__main__":
    main()
