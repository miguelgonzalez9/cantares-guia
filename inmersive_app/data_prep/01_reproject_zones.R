# 01_reproject_zones.R
# Phase 0 — reproject the reserve zoning shapefile (CTM12 / EPSG:9377)
# to WGS84 (EPSG:4326) for use as web-map layers, and export GeoJSON.
#
# Input : inputs/maps/Reserva Natural Cantares_2282/1.shp
# Output: app/public/data/zones.geojson   (+ a printed area sanity-check)
#
# Run:  "C:/Program Files/R/R-4.5.0/bin/Rscript.exe" data_prep/01_reproject_zones.R
# (run from the inmersive_app/ directory, or edit `root` below)

suppressPackageStartupMessages({
  ok <- requireNamespace("sf", quietly = TRUE)
})
if (!ok) stop("Package 'sf' is not installed. Install with install.packages('sf').")
library(sf)

# --- paths (robust to where the script is launched from) ---
args_file <- commandArgs(trailingOnly = FALSE)
this <- sub("^--file=", "", args_file[grep("^--file=", args_file)])
root <- if (length(this)) normalizePath(file.path(dirname(this), "..")) else normalizePath("..")
shp  <- file.path(root, "inputs", "maps", "Reserva Natural Cantares_2282", "1.shp")
out_dir <- file.path(root, "app", "public", "data")
dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
out <- file.path(out_dir, "zones.geojson")

# --- read + inspect ---
z <- st_read(shp, quiet = TRUE)
cat("Source CRS:\n"); print(st_crs(z)$input)
cat("\nAttribute fields:\n"); print(names(z))
cat("\nFeature count:", nrow(z), "\n")

# --- area sanity check in the projected (metric) CRS BEFORE transform ---
z$area_ha <- as.numeric(st_area(z)) / 10000
cat("\nArea by feature (ha):\n"); print(z$area_ha)
cat("Total area (ha):", round(sum(z$area_ha), 4), " (expected ~31.07)\n")

# --- reproject to WGS84 for the web map ---
z84 <- st_transform(z, 4326)

# --- write GeoJSON (overwrite) ---
if (file.exists(out)) file.remove(out)
st_write(z84, out, driver = "GeoJSON", quiet = TRUE)
cat("\nWrote:", out, "\n")
cat("Bounding box (lon/lat):\n"); print(st_bbox(z84))
