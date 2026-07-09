# 04_ortho_tiles.R  — TEMPLATE (needs the orthophoto GeoTIFF)
# Turn the 1:2000 photogrammetric orthophoto into web tiles for the
# before/after slider in the Restauración view, and (if a DSM/DTM exists)
# derive a canopy height model for canopy-tree crown detection.
#
# Input : inputs/ortho/cantares_ortho.tif   (georeferenced RGB orthophoto)
#         inputs/ortho/dsm.tif, inputs/ortho/dtm.tif  (optional, for CHM)
# Output: app/public/tiles/ortho.pmtiles    (raster tiles; add as a map source)
#         app/public/data/crowns.geojson    (optional detected tree crowns)
#
# Run:    "C:/Program Files/R/R-4.5.0/bin/Rscript.exe" data_prep/04_ortho_tiles.R

suppressPackageStartupMessages(library(terra))
root <- normalizePath(file.path(dirname(sub("^--file=", "",
  commandArgs(FALSE)[grep("^--file=", commandArgs(FALSE))])), ".."))
ortho <- file.path(root, "inputs", "ortho", "cantares_ortho.tif")
if (!file.exists(ortho)) stop("Place the orthophoto at inputs/ortho/cantares_ortho.tif first.")

r <- rast(ortho)
r <- project(r, "EPSG:3857")   # web mercator for tiling
cat("Ortho:", ncol(r), "x", nrow(r), "px, res ~", round(res(r)[1], 3), "m\n")

# Tiling to PMTiles is done with the `pmtiles`/`rio-mbtiles`+`pmtiles convert`
# CLI (outside R). Recommended pipeline:
#   gdal2tiles.py / gdalwarp -> MBTiles (gdal_translate -of MBTILES)
#   pmtiles convert ortho.mbtiles app/public/tiles/ortho.pmtiles
# Then add to the map style as a raster source pointing at the PMTiles archive.

# --- Optional: canopy height model + crown detection (needs DSM & DTM) ---
dsm <- file.path(root, "inputs", "ortho", "dsm.tif")
dtm <- file.path(root, "inputs", "ortho", "dtm.tif")
if (file.exists(dsm) && file.exists(dtm)) {
  chm <- rast(dsm) - rast(dtm)
  # ForestTools::vwf() local-maxima on the CHM detects canopy trees.
  # Honest caveat: at ~15-25 cm GSD this finds CANOPY trees, not saplings.
  message("CHM built — run ForestTools::vwf() for crown detection; export crowns.geojson.")
} else {
  message("No DSM/DTM — before/after ortho slider only; skipping crown detection.")
}
message("TEMPLATE: finish the PMTiles conversion step to enable the in-app ortho slider.")
