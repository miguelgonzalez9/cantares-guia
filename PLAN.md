# Cantares — Interactive Reserve Guide, Reforestation Monitor & Species Game

## Context

The owner of **Reserva Natural Cantares** (RNSC 112‑20; 31.07 ha; vereda Las Palomas,
~5 km N of Manizales, inside RFP Río Blanco; ~2,500 masl; *bosque muy húmedo montano
bajo*) wants a digital system for a reforestation + ecotourism project with three pillars:

1. **Location-aware interactive trail guide** — themed routes (water / trees / birds),
   live GPS on the senderos, waypoints with rich content.
2. **Reforestation monitoring** — visualize recovery of the 16.4 ha *Zona de Restauración*
   (degraded kikuyo pasture, cattle stopped ~2019) with imagery + credible carbon metrics.
3. **Gamified species ID that doubles as an AI-assisted biodiversity inventory.**

The resolution also imposes a legal obligation: a **Plan de Manejo within one year**,
including biodiversity monitoring — pillar 3's inventory directly serves that.

### Inputs on hand vs. arriving
| Input | Status | Use |
|---|---|---|
| Resolution PDF (zoning, ~60-species flora list, "possible fauna" list, life zone) | **Have** | Seed species tables, zone descriptions, context |
| Reserve boundary + 5-zone shapefile, **CRS = CTM12 / EPSG:9377** | **Have** | Base map for all three pillars |
| GPS trail traces (owner walks with phone) | Days away | Pillar 1 routes |
| Geo-referenced waypoints + photos + descriptions | Days away | Pillar 1 content |
| **1:2000 photogrammetric orthophoto** (~15–25 cm GSD; ask if DSM/DTM exists) | Days away | Pillar 2 baseline + crown detection |
| Geo-referenced key-tree inventory (species, DBH, height, photos) | Days away | Pillar 2 carbon + pillar 3 cards |
| Reserve/season photos | Days away | Content across pillars |

### Decisions locked (from clarifying questions)
- **Platform:** installable **PWA** (offline vector map + live GPS, one codebase, free static hosting).
- **Species engine (ecosystem-matched, multi-tool — NOT iNat auto-ID alone):**
  - **Plants → Pl@ntNet constrained to the "Tropical Andes" regional flora** (offline pack; far more accurate here than a global model) + a **curated in-app guide of the reserve's ~60 documented species** (bounded checklist beats global CV).
  - **Birds → Merlin Bird ID** (Colombia pack, photo + Sound ID, offline) as the recommended companion app; **BirdNET** for audio breadth (embeddable via API).
  - **Cryptic mammals → camera traps + Wildlife Insights AI** (not tourist-facing; the "possible fauna" list is nocturnal/cryptic).
  - **Inventory backbone → iNaturalist project** for aggregation + **community** verification, publishing onward to **GBIF / SiB Colombia** — used for the *inventory/verification layer*, not primary instant-ID.
  - A game UI abstracts over these: plant→Pl@ntNet API, bird audio→BirdNET API, bird→ "open in Merlin", everything→post to the iNat project.
- **First build:** **Trail-guide MVP** (its map framework is the base for pillars 2 & 3).
- **Imagery:** 1:2000 ortho → canopy/crown scale + before/after overlay; **not** sapling-level. Free satellite (Sentinel-2 / Planet NICFI) supplies the 2019→now greening time-series.

### Honest scope corrections (referee mode)
- **"Oxygen production" is not a defensible metric.** Replace with **above-ground biomass →
  carbon → CO₂e** via allometric equations on the key-tree inventory, reported with uncertainty.
- **Per-tree detection is partial**, not total, at 1:2000 — canopy trees yes, restoration saplings no.
  The temporal recovery story comes from NDVI, not tree counting.
- **Global auto-ID (esp. iNaturalist's CV) underperforms on montane tropical flora** — few observations
  per species over an enormous flora. Fix: **ecosystem-tuned tools** (Pl@ntNet Tropical Andes flora,
  Merlin Colombia) **+ a bounded local checklist**, with iNat used for community verification/inventory,
  not primary instant-ID. Still don't train a bespoke model up front — revisit only once labeled reserve
  photos accumulate (then a tiny classifier over ~100–150 known species is cheap and could beat all of them).

### Division of labor
- **Owner (R-strong, on-site):** field data collection; R data-prep (`sf`, `terra`, `rgee`) — plays to existing skills.
- **Claude Code:** generates/maintains the JS PWA, content pipelines, deployment. (Owner does not need to write JS.)

---

## Architecture

```
                    ┌───────────────────────────────────────┐
                    │  DATA PREP (R — owner's strength)       │
                    │  sf: reproject 9377→4326, clip zones,   │
                    │  GPX→GeoJSON; terra/rgee: NDVI, ortho    │
                    └───────────────────┬─────────────────────┘
                                        │  GeoJSON / PMTiles / JSON
                                        ▼
   ┌──────────────────────────── PWA (MapLibre GL JS) ─────────────────────────────┐
   │ Pillar 1 Trail guide   │ Pillar 2 Restoration story │ Pillar 3 Species game      │
   │ routes + GPS + waypoint│ ortho slider + NDVI curve  │ Pl@ntNet(Andes)+BirdNET    │
   │ proximity cards        │ + carbon card              │ +Merlin link +curated guide│
   │ offline (service worker + PMTiles), installable, QR at trailhead                 │
   └─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼  observations
              iNaturalist "Proyecto Cantares"  →  GBIF / SiB Colombia (live inventory → Plan de Manejo)
```

### Tech stack & rationale
- **Map:** MapLibre GL JS (open-source) + **PMTiles** single-file offline tiles — no tile server, served from static hosting.
- **Frontend:** Vite + React (or minimal vanilla) PWA; **Workbox** service worker for offline; browser **Geolocation `watchPosition`** for GPS (works with no cell signal).
- **Data layers:** trails = GeoJSON LineString (theme tags); waypoints = GeoJSON Point (title, theme, media, text, audio); zones from the existing shapefile.
- **Hosting:** GitHub Pages / Cloudflare Pages / Netlify — free, HTTPS (required for GPS + install), ~$0/mo.
- **Species (ecosystem-matched):** Pl@ntNet API constrained to **Tropical Andes flora** (plants); **BirdNET** API (bird audio); **Merlin Bird ID** as deep-linked companion (best Neotropical bird ID, *no public API* → cannot embed); iNaturalist API (post observations + pull inventory) publishing to **GBIF/SiB Colombia**; curated offline checklist for the reserve's documented species.
- **Remote sensing:** R `terra` (ortho → COG/PMTiles overlay), `rgee`/Google Earth Engine or `sits` (Sentinel-2 NDVI), `lidR`/`ForestTools` (crown detection if CHM exists), Chave 2014 / Colombian montane allometry for biomass.

### Repo scaffold (to create under `inmersive_app/`)
```
inmersive_app/
  inputs/            # existing: documentos/, maps/
  data_prep/         # R scripts (owner + Claude)
    01_reproject_zones.R      # shp 9377→4326 → zones.geojson
    02_process_traces.R       # GPX → trails.geojson
    03_ndvi_timeseries.R      # Sentinel-2 greening curve
    04_ortho_tiles.R          # ortho → PMTiles overlay
    05_carbon_allometry.R     # key-tree inventory → AGB/CO2e
  app/               # PWA (Claude-generated/maintained)
    src/ (map, routes, waypoints, game, restoration story)
    public/data/     # zones.geojson, trails.geojson, waypoints.geojson, species.json
    public/tiles/    # base.pmtiles, ortho.pmtiles
  content/           # waypoint text, species cards (markdown + media)
```

---

## Pillar 1 — Interactive trail guide (BUILD FIRST)

**Inputs:** boundary + zones shapefile (have); GPS traces (owner); waypoints + photos + text (owner); themed-route definitions (water/trees/birds/restoration).

**Processes:**
- `01_reproject_zones.R` — `sf::st_transform(9377→4326)`, export `zones.geojson` (verify against the resolution's Figura 1 zoning map).
- `02_process_traces.R` — GPX → clean/simplify → `trails.geojson` with `theme` tags.
- Content authoring — owner drops points + voice notes + photos; Claude drafts/structures/translates waypoint cards.
- App — MapLibre base + zones + trails; `watchPosition` "you-are-here" dot; **proximity trigger** (within ~15–25 m of a waypoint → surface its card); route selector filters by theme; offline caching.

**Outputs:** installable offline PWA; themed GPS-aware routes; waypoint cards (text/photo/audio); QR at trailhead to install.

## Pillar 2 — Reforestation monitoring

**Inputs:** 1:2000 ortho (+ DSM/DTM if it exists — **ask**); *Restauración* polygon (have); Sentinel-2/Planet NICFI (free); key-tree inventory (owner).

**Processes:**
- `04_ortho_tiles.R` — georeference/ingest ortho → COG/PMTiles overlay; **before/after opacity slider** in-app.
- `03_ndvi_timeseries.R` — Sentinel-2 NDVI 2019→now, **mean in Restauración vs. Conservación as control** → greening curve (the credible temporal "process").
- Crown detection (conditional on CHM) — `lidR`/`ForestTools` local-maxima on canopy trees; honest caveat on saplings.
- `05_carbon_allometry.R` — allometry (Chave 2014 / montane wood densities) on key-tree DBH+height → AGB → C (×0.47) → CO₂e (×3.67), **with confidence intervals**; cross-check per-ha vs. published bmh-MB values.

**Outputs:** ortho before/after slider; NDVI greening animation + curve; recovered-area stat; carbon-stock card with CIs; "Restoration story" mode in the PWA.

## Pillar 3 — Species game + AI inventory (ecosystem-matched ID)

**Inputs:** flora starter list (~60 spp, have); "possible fauna" list (have); flagship species cards (owner + Claude); iNaturalist project; **Pl@ntNet Tropical Andes flora** + **BirdNET** APIs; **Merlin** (companion); reserve photos/audio (owner, growing).

**Processes:**
- **Curated offline checklist first** — build `species.json` from the documented ~60 flora + possible fauna, each with photos, common/scientific/family, zone/route where seen. This is the *always-works* layer, no API, and constrains every CV tool to the local checklist.
- **Ecosystem-matched capture, routed by taxon:**
  - Plant photo → **Pl@ntNet API (Tropical Andes flora)** → candidate matches filtered to the reserve checklist.
  - Bird sound → **BirdNET API**; also prompt "**open in Merlin**" (best Neotropical bird ID, offline) as the recommended companion.
  - Anything → **post to the iNaturalist "Proyecto Cantares"** (place = reserve polygon) for **community** verification.
- **Cryptic mammals (separate track, not tourist-facing):** camera traps → **Wildlife Insights** AI for tigrillo/paca/cusumbo etc. — the only realistic way to inventory the nocturnal fauna list.
- **Game layer** — per-route "species bingo"/scavenger cards; correct ID → points/badges; every capture feeds the inventory.
- **Curated flagship cards** (~10–15: Barranquero, Yarumo, Roble, Encenillo, Tigrillo, Cusumbo…) with "you might see me on the *aves*/*árboles*/*agua* route."
- **Inventory dashboard** — pull iNat API → live species count, life-list, recent sightings; iNat publishes onward to **GBIF/SiB Colombia**, giving national legitimacy and feeding the **Plan de Manejo** monitoring obligation.

**Outputs:** gamified ID with ecosystem-accurate engines; curated offline field guide; growing community-verified inventory (iNat → SiB Colombia); camera-trap mammal records; flagship cards; inventory dashboard.

---

## Phased roadmap

- **Phase 0 — now (only shp + doc):** scaffold repo; reproject zones; base-map PWA shell (offline + GPS dot); seed `species.json` from the doc's flora/fauna tables; create iNat project. *All doable immediately by Claude.*
- **Phase 1 — trail MVP (after owner collects traces + waypoints):** themed routes, proximity cards, offline packaging → **first usable deliverable / trailhead QR.**
- **Phase 2 — reforestation (after ortho + key-tree inventory):** ortho slider, NDVI curve, carbon card.
- **Phase 3 — species game:** capture flow, flagship cards, inventory dashboard.
- **Phase 4 — polish & field test:** offline stress test, multilingual (ES/EN) content, on-trail validation.

## Field data-collection protocol (for the owner, on-site)
- **Trails:** GPX-logging app (OsmAnd / Organic Maps / GPX Logger), GPS "high accuracy," one track file per sendero, steady pace.
- **Waypoints:** at each key point — GPS point + 2–3 photos + 30-sec voice note on what's there; consistent naming.
- **Key trees:** per flagship tree — GPS point, species, DBH (tape @1.3 m), est. height, photos (trunk / leaf / whole). Feeds carbon **and** species cards.
- **Imagery request:** confirm ortho resolution/format **and whether the flight produced a DSM/DTM or point cloud** (decides tree-detection feasibility).
- **Birds:** use **Merlin (Colombia pack)** for photo + Sound ID in the field; sync to eBird/iNat.
- **Plants:** use **Pl@ntNet with the Tropical Andes flora pack downloaded** (offline); cross-check against the reserve checklist.
- **Cryptic fauna:** deploy **camera traps** at water sources / game trails → Wildlife Insights. Fauna has *no* field inventory yet — the biggest data gap and where camera traps matter most.

## Verification (end-to-end)
- **Data:** run R scripts; overlay `zones.geojson` on a web map and **visually match the resolution's Figura 1** (same 5 zones, same shape).
- **Offline PWA:** load app → airplane mode → confirm tiles + content render and GPS dot moves on a real trail walk.
- **Proximity:** walk to a waypoint → card fires within threshold.
- **NDVI:** greening trend positive post-2019 in Restauración, ~flat in Conservación (control) — sanity check.
- **Carbon:** per-ha AGB within order of magnitude of published montane values.
- **Species ID (ecosystem fit):** run **Pl@ntNet with Tropical Andes flora** on 8–10 of the reserve's *documented* species (Yarumo, Roble, Encenillo, Drago…) → top match correct at genus/species. Record a known birdsong with **Merlin/BirdNET** → correct family/species. If accuracy is poor, the curated checklist still carries the experience.
- **Inventory:** post a test observation to the iNat "Proyecto Cantares" inside the boundary → confirm it appears in the project + dashboard, and that the project is set to publish to GBIF/SiB Colombia.

## Key assumptions & open uncertainties
- **Assumes** static free hosting is acceptable (no backend); phone GPS accuracy (~5–10 m) is adequate for trail proximity — *validate on the first field walk.*
- **Assumes** the ortho is georeferenced and delivered as GeoTIFF; carbon estimates cover only inventoried key trees (not whole-reserve extrapolation) unless a stratified sample is added.
- **Uncertain:** whether a DSM/DTM exists (gates crown detection); whether one ortho date suffices (a second flight would strengthen the before/after story); connectivity at the trailhead for first install (QR + pre-download mitigates).
- **Deviation from "standard":** reframing pillar 2 from "oxygen/individual-tree" to "NDVI greening + allometric carbon" — deliberate, for scientific defensibility.
- **Species-tool constraints:** **Merlin has no public ID API** → it's a deep-linked companion app, not embedded (accept, or embed only Pl@ntNet/BirdNET which do have APIs). Pl@ntNet's Tropical Andes flora improves but does not guarantee montane accuracy — the **curated offline checklist is the reliability floor**. iNat CV is deliberately demoted to the verification/inventory layer. A bespoke classifier is deferred until labeled reserve photos exist.
