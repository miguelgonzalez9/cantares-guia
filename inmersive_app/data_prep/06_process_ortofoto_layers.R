# 06_process_ortofoto_layers.R
# Convert the owner's real reserve layers (shapes_ortofoto, EPSG:3116) into
# web GeoJSON for the app: boundary, management zones, and the trail network.
# Run via PowerShell:  & "C:/Program Files/R/R-4.5.0/bin/Rscript.exe" data_prep/06_process_ortofoto_layers.R

suppressPackageStartupMessages(library(sf))
sf_use_s2(FALSE)

root <- "C:/Users/migol/Dropbox/Cantares/inmersive_app"
d    <- file.path(root, "inputs", "maps", "shapes_ortofoto")
outd <- file.path(root, "app", "public", "data")
dir.create(outd, showWarnings = FALSE, recursive = TRUE)

read4326 <- function(name) {
  x <- st_read(file.path(d, paste0(name, ".shp")), quiet = TRUE)
  st_transform(st_zm(x), 4326)
}
write_gj <- function(x, file) {
  p <- file.path(outd, file)
  if (file.exists(p)) file.remove(p)
  st_write(x, p, driver = "GeoJSON", quiet = TRUE)
  cat("wrote", file, "(", nrow(x), "features )\n")
}

# --- boundary (limite_predial) ---
bnd <- read4326("limite_predial")
bnd <- st_union(bnd) |> st_sf(geometry = _)
bnd$name <- "Reserva Natural Cantares"
write_gj(bnd["name"], "boundary.geojson")

# --- management zones: one file each -> combined, tagged by `zona` ---
zone_files <- c(
  "Zona_conservacion" = "conservacion",
  "uso intensivo"     = "uso_intensivo",
  "Agroecosistema"    = "agroecosistema",
  "Transicion"        = "transicion"
)
zparts <- lapply(names(zone_files), function(f) {
  z <- read4326(f)
  g <- st_union(z)
  st_sf(zona = unname(zone_files[f]), geometry = g)
})
zones <- do.call(rbind, zparts)
write_gj(zones, "zones.geojson")

# --- trail network (camino) — polygon footprint of the paths ---
cam <- read4326("camino")
cam <- st_union(cam) |> st_sf(geometry = _)
cam$name <- "Senderos"
write_gj(cam["name"], "caminos.geojson")

cat("\nDone. Zones present:", paste(zones$zona, collapse = ", "), "\n")
cat("NOTE: this 2020 zonification predates Res.201/2021; areas differ from the final resolution.\n")
