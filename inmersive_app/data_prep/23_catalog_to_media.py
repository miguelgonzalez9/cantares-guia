#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
23_catalog_to_media.py — bridge classified photos → app species inventory.

THE missing integration link: every upstream pipeline (classifier catalogs, tree
inventory, eBird) keys species by SCIENTIFIC NAME; the app keys by common-name-slug
`id`. This script resolves that join and turns FP-safe, in-scope classified photos
into curated app media.

Selection gate (owner's decision: "species-confirmed OR in-reserve GPS"):
  - species_checked == True  → BioCLIP confirmed the species against the CLOSED
    reserve inventory (cannot invent a non-reserve species) = FP-safe, in-scope; OR
  - EXIF GPS inside the reserve bbox (RES_BBOX from 10_process_photos).
Then: resolve scientific_name → species.id, rank per species by confidence, keep the
top --per-species (storage is limited → a curated few, bundled in the repo).

Two modes:
  (default) MANIFEST — writes `_enrich/media_manifest.json` + prints a summary.
            Copies/optimizes NOTHING. Review this, then apply.
  --apply   materializes each pick: optimized WebP+JPG+thumb into
            app/public/img/species/<id>__<n>.webp and a media.json entry
            (subject_type=species). Idempotent by source file. Sets species.photo
            (cover) when the record has none.

Usage:
  python 23_catalog_to_media.py                         # manifest, per-species 3
  python 23_catalog_to_media.py --per-species 1 --only-missing-photo
  python 23_catalog_to_media.py --apply --per-species 1
"""
import argparse, importlib.util, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SPECIES = os.path.join(HERE, "..", "app", "public", "data", "species.json")
ARCHIVE_CATALOG = os.path.join(HERE, "_archive_work", "catalog_fotos-reserva-cantares.json")
MANIFEST = os.path.join(HERE, "_enrich", "media_manifest.json")
CREDIT = "Reserva Natural Cantares"
LICENSE = "CC BY-NC 4.0"


def norm(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def load_mod10():
    """Load 10_process_photos.py (digit-prefixed → importlib) for its helpers."""
    p = os.path.join(HERE, "10_process_photos.py")
    spec = importlib.util.spec_from_file_location("mod10", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def load_species():
    with open(SPECIES, encoding="utf-8") as f:
        return json.load(f)


def in_reserve_bbox(lat, lon, bbox):
    if lat is None or lon is None:
        return False
    return (bbox["lat_min"] <= lat <= bbox["lat_max"]
            and bbox["lon_min"] <= lon <= bbox["lon_max"])


def gather(catalog_path, by_sci, per_species, only_missing, bbox, flagship_only=False):
    """Return {species_id: {..., picks:[...]}} after gate + rank + cap."""
    with open(catalog_path, encoding="utf-8") as f:
        cat = json.load(f)
    base = cat.get("base", "")
    items = cat.get("items", [])
    buckets = {}
    kept = skipped_unresolved = 0
    for it in items:
        sci = norm(it.get("scientific_name"))
        if not sci:
            continue
        # FP-safe / in-scope gate.
        gps_ok = in_reserve_bbox(it.get("lat"), it.get("lon"), bbox)
        if not (it.get("species_checked") or gps_ok):
            continue
        sp = by_sci.get(sci)
        if not sp:
            skipped_unresolved += 1
            continue
        if flagship_only and not sp.get("flagship"):
            continue
        if only_missing and sp.get("photo"):
            continue
        b = buckets.setdefault(sp["id"], {
            "species_id": sp["id"], "scientific_name": sp["scientific_name"],
            "common_name": sp.get("common_name"), "group": sp.get("group"),
            "has_photo": bool(sp.get("photo")), "picks": []})
        b["picks"].append({
            "src": os.path.join(base, it["file"].replace("/", os.sep)),
            "rel": it["file"], "kind": it.get("kind", "photo"),
            "category": it.get("category"), "confidence": it.get("confidence", 0),
            "gps": [it.get("lon"), it.get("lat")] if gps_ok else None})
        kept += 1
    # rank per species by confidence desc, then cap
    for b in buckets.values():
        b["picks"].sort(key=lambda p: p["confidence"], reverse=True)
        b["n_available"] = len(b["picks"])
        b["picks"] = b["picks"][:per_species]
    return buckets, kept, skipped_unresolved


def write_manifest(buckets):
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    rows = sorted(buckets.values(),
                  key=lambda b: (b["group"] or "", b["scientific_name"]))
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)


def apply(buckets, mod10):
    """Materialize picks into app/public/img + media.json. Idempotent by source file."""
    from PIL import Image  # noqa: local import, only needed on --apply
    media = mod10.load_json(mod10.MEDIA_JSON) if os.path.exists(mod10.MEDIA_JSON) else {"_meta": {}, "photos": []}
    photos = media.setdefault("photos", [])
    done = {p.get("source_file") for p in photos if p.get("source_file")}
    doc = load_species()
    sp_by_id = {s["id"]: s for s in doc["species"]}
    out_dir = mod10.IMG / "species"
    added = 0
    # next per-subject index so filenames don't collide with existing media
    def next_idx(sid):
        n = 0
        for p in photos:
            if p.get("subject_type") == "species" and p.get("subject_id") == sid:
                m = re.search(r"__(\d+)\.", p.get("file", ""))
                if m:
                    n = max(n, int(m.group(1)))
        return n + 1
    for b in sorted(buckets.values(), key=lambda b: b["scientific_name"]):
        sid = b["species_id"]
        has_primary = any(p.get("subject_type") == "species" and p.get("subject_id") == sid and p.get("is_primary") for p in photos)
        for pick in b["picks"]:
            if pick["rel"] in done or not os.path.exists(pick["src"]):
                continue
            try:
                img = Image.open(pick["src"])
                idx = next_idx(sid)
                stem = f"{sid}__{idx}"
                webp, jpg, thumb, (w, h) = mod10.save_variants(img, out_dir, mod10.THUMBS, stem)
            except Exception as e:
                print(f"  ! {pick['rel']}: {e}", file=sys.stderr)
                continue
            primary = not has_primary
            has_primary = True
            rec = {"file": mod10.rel(webp), "jpg": mod10.rel(jpg), "thumb": mod10.rel(thumb),
                   "subject_type": "species", "subject_id": sid, "kind": "photo",
                   "is_primary": primary, "credit": CREDIT, "license": LICENSE,
                   "caption": None, "caption_en": None, "taken": None,
                   "w": w, "h": h, "source": "archivo_cantares", "source_file": pick["rel"]}
            if pick["gps"]:
                rec["lon"], rec["lat"] = pick["gps"]
            photos.append(rec)
            done.add(pick["rel"])
            added += 1
            if primary and not sp_by_id.get(sid, {}).get("photo"):
                sp_by_id[sid]["photo"] = mod10.rel(webp)
    if added:
        with open(mod10.MEDIA_JSON, "w", encoding="utf-8") as f:
            json.dump(media, f, ensure_ascii=False, indent=2)
        with open(SPECIES, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
    return added


def rollback(mod10):
    """Undo --apply: drop media entries with source=archivo_cantares, delete their
    files, and clear any species.photo that pointed at them."""
    if not os.path.exists(mod10.MEDIA_JSON):
        return 0
    media = mod10.load_json(mod10.MEDIA_JSON)
    photos = media.get("photos", [])
    keep, drop = [], []
    for p in photos:
        (drop if p.get("source") == "archivo_cantares" else keep).append(p)
    dropped_files = set()
    for p in drop:
        for k in ("file", "jpg", "thumb"):
            rp = p.get(k)
            if rp:
                dropped_files.add(rp)
                fp = os.path.join(os.path.dirname(mod10.MEDIA_JSON), "..", rp.replace("/", os.sep))
                try:
                    os.remove(os.path.normpath(fp))
                except OSError:
                    pass
    media["photos"] = keep
    with open(mod10.MEDIA_JSON, "w", encoding="utf-8") as f:
        json.dump(media, f, ensure_ascii=False, indent=2)
    doc = load_species()
    for s in doc["species"]:
        if s.get("photo") in dropped_files:
            s["photo"] = None
    with open(SPECIES, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    return len(drop)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default=ARCHIVE_CATALOG)
    ap.add_argument("--per-species", type=int, default=3)
    ap.add_argument("--only-missing-photo", action="store_true",
                    help="only species that currently have no cover photo")
    ap.add_argument("--flagship-only", action="store_true",
                    help="only flagship (★) species")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--rollback", action="store_true",
                    help="undo a previous --apply: delete archivo_cantares media + files, unset species.photo")
    ap.add_argument("--curated", metavar="PATH",
                    help="apply an explicit hand-vetted picks file (skips gate/rank; --apply implied)")
    args = ap.parse_args()

    mod10 = load_mod10()
    doc = load_species()
    by_sci = {norm(s["scientific_name"]): s for s in doc["species"]}

    if args.rollback:
        print(f"rolled back: {rollback(mod10)} media entries + files removed")
        return

    if args.curated:
        with open(args.curated, encoding="utf-8") as f:
            rows = json.load(f)
        buckets = {b["species_id"]: b for b in rows}
        added = apply(buckets, mod10)
        print(f"curated apply: {added} new media entries from {os.path.basename(args.curated)}")
        return

    if not os.path.exists(args.catalog):
        print(f"catalog not found: {args.catalog}", file=sys.stderr)
        sys.exit(1)
    buckets, kept, unresolved = gather(args.catalog, by_sci, args.per_species,
                                       args.only_missing_photo, mod10.RES_BBOX,
                                       args.flagship_only)
    n_species = len(buckets)
    n_picks = sum(len(b["picks"]) for b in buckets.values())
    print(f"catalog: {os.path.basename(args.catalog)}")
    print(f"gate passed & resolved: {kept} photos across {n_species} species "
          f"(unresolved sci: {unresolved})")
    print(f"selected (cap {args.per_species}/species): {n_picks} photos")
    miss = sum(1 for b in buckets.values() if not b["has_photo"])
    print(f"species that would gain a FIRST cover photo: {miss}")

    if not args.apply:
        write_manifest(buckets)
        print(f"manifest → {MANIFEST}  (review, then re-run with --apply)")
        # top-covered species preview
        top = sorted(buckets.values(), key=lambda b: b["n_available"], reverse=True)[:8]
        print("most-photographed species:")
        for b in top:
            print(f"  {b['n_available']:3d}  {b['common_name'] or b['scientific_name']} ({b['group']})")
        return
    added = apply(buckets, mod10)
    print(f"applied: {added} new media entries written to media.json + img/species/")


if __name__ == "__main__":
    main()
