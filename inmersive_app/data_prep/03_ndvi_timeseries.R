# 03_ndvi_timeseries.R  — TEMPLATE (needs Earth Engine auth via rgee)
# Build the reforestation "greening" curve: mean NDVI over time in the
# Zona de Restauración vs. the Zona de Conservación (control), 2019 -> now,
# from Sentinel-2. Output feeds the Restauración view.
#
# Requires: internal management zones as polygons. The delivered shapefile is
# the reserve BOUNDARY only (1 feature) — digitize the 5 zones first (trace on
# site, or georeference Figura 1 of the resolution) into inputs/maps/zones_5.*
#
# Input : inputs/maps/zones_5.geojson  (fields: zona = "restauracion"|"conservacion"|...)
# Output: app/public/data/ndvi.json    ({ dates: [...], restauracion: [...], conservacion: [...] })
#
# Setup:  install.packages("rgee"); rgee::ee_install(); rgee::ee_Initialize()
# Run:    "C:/Program Files/R/R-4.5.0/bin/Rscript.exe" data_prep/03_ndvi_timeseries.R

suppressPackageStartupMessages({ library(rgee); library(sf) })
ee_Initialize()

root <- normalizePath(file.path(dirname(sub("^--file=", "",
  commandArgs(FALSE)[grep("^--file=", commandArgs(FALSE))])), ".."))
zones <- st_read(file.path(root, "inputs", "maps", "zones_5.geojson"), quiet = TRUE)

s2 <- ee$ImageCollection("COPERNICUS/S2_SR_HARMONIZED")$
  filterDate("2019-01-01", "2026-12-31")$
  filter(ee$Filter$lt("CLOUDY_PIXEL_PERCENTAGE", 40))$
  map(function(img) {
    ndvi <- img$normalizedDifference(c("B8", "B4"))$rename("NDVI")
    img$addBands(ndvi)$copyProperties(img, list("system:time_start"))
  })

# Monthly-median NDVI, then reduceRegions over each zone. Left as an exercise to
# export to inputs and write ndvi.json — see rgee ee_extract() / ee_as_sf().
stop("TEMPLATE: complete the ee_extract() export to app/public/data/ndvi.json once zones_5 exists and EE is authenticated.")
