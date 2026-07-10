# 10_import_qgis_layers.R
# Import the owner's QGIS GeoPackages (trails.gpkg, waypoints.gpkg) into the
# app's GeoJSON, normalizing the `routes` tags to ASCII ids (strip accents,
# fix typos) so they match the recorrido ids. Run via PowerShell Rscript.
suppressPackageStartupMessages(library(sf))
sf_use_s2(FALSE)
d <- "C:/Users/migol/Dropbox/Cantares/inmersive_app/app/public/data"

strip_acc <- function(x) chartr("áéíóúüñ", "aeiouun", x)
norm_routes <- function(s) {
  if (is.na(s) || s == "") return("")
  p <- trimws(unlist(strsplit(s, ",")))
  p <- strip_acc(tolower(p))
  p <- gsub("regenracion", "regeneracion", p)   # fix typo
  p <- gsub("^flores$", "flora", p)             # unify flores -> flora
  p <- p[p != ""]
  paste(unique(p), collapse = ",")
}

write_gj <- function(x, name) {
  x <- st_transform(st_zm(x), 4326)
  x$routes <- vapply(as.character(x$routes), norm_routes, character(1))
  p <- file.path(d, name)
  if (file.exists(p)) file.remove(p)
  st_write(x, p, driver = "GeoJSON", quiet = TRUE)
  cat("wrote", name, "(", nrow(x), "features )\n")
  x
}

tr <- write_gj(st_read(file.path(d, "trails.gpkg"), quiet = TRUE), "trails.geojson")
wp <- write_gj(st_read(file.path(d, "waypoints.gpkg"), layer = "PUNTOS CLAVE", quiet = TRUE), "waypoints.geojson")

toks <- unique(unlist(strsplit(paste(c(tr$routes, wp$routes), collapse = ","), ",")))
cat("\nRECORRIDOS usados:", paste(sort(toks[toks != ""]), collapse = ", "), "\n")
