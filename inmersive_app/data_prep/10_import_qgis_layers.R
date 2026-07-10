# 10_import_qgis_layers.R
# Import the owner's QGIS GeoPackages (trails.gpkg, waypoints.gpkg) into the
# app's GeoJSON, normalizing the `routes` tags to ASCII ids (strip accents,
# fix typos) so they match the recorrido ids, and normalizing the new `tipo`
# attribute (mirador / avistamiento / agua / flora / servicio) used by the
# app's legend filters. Run via PowerShell Rscript.
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

# Canonical tipo slugs. Where the owner left `tipo` empty we INFER one from the
# title (reported below) so the legend filter is useful today; the field in the
# .gpkg remains the source of truth once every point is tagged.
infer_tipo <- function(tipo, title) {
  tp <- strip_acc(tolower(trimws(as.character(tipo))))
  if (!is.na(tp) && tp %in% c("mirador","avistamiento","agua","flora","servicio")) return(tp)
  tt <- strip_acc(tolower(as.character(title)))
  if (grepl("^mirador", tt))                                  return("mirador")
  if (grepl("avistamiento|nido|comedero|colibr", tt))         return("avistamiento")
  if (grepl("cascada|tanque|quebrada|nacimiento", tt))        return("agua")
  if (grepl("bosque|sietecuero|vivero|jardin", tt))           return("flora")
  if (grepl("casa|cabana|entrada|portada", tt))               return("servicio")
  "punto"
}

write_gj <- function(x, name, has_tipo = FALSE) {
  x <- st_transform(st_zm(x), 4326)
  x$routes <- vapply(as.character(x$routes), norm_routes, character(1))
  if (has_tipo) {
    given <- if ("tipo" %in% names(x)) x$tipo else rep(NA, nrow(x))
    x$tipo <- vapply(seq_len(nrow(x)), function(i) infer_tipo(given[i], x$title[i]), character(1))
    inferred <- is.na(given) | trimws(as.character(given)) == ""
    if (any(inferred))
      cat("  tipo INFERIDO para:", paste(sprintf("%s=%s", x$id[inferred], x$tipo[inferred]), collapse = ", "), "\n")
    # Dedupe ids (the owner has a duplicate punto_15) so the app keys stay unique.
    dup <- duplicated(x$id)
    if (any(dup)) { cat("  ids DUPLICADOS renombrados:", paste(x$id[dup], collapse = ", "), "\n"); x$id[dup] <- paste0(x$id[dup], "b") }
  }
  p <- file.path(d, name)
  if (file.exists(p)) file.remove(p)
  st_write(x, p, driver = "GeoJSON", quiet = TRUE)
  cat("wrote", name, "(", nrow(x), "features )\n")
  x
}

tr <- write_gj(st_read(file.path(d, "trails.gpkg"), quiet = TRUE), "trails.geojson")
# Read the `puntos_clave` layer (lowercase) — it carries the `tipo` attribute;
# the "PUNTOS CLAVE" layer is an older copy without it.
wp <- write_gj(st_read(file.path(d, "waypoints.gpkg"), layer = "puntos_clave", quiet = TRUE),
               "waypoints.geojson", has_tipo = TRUE)

toks <- unique(unlist(strsplit(paste(c(tr$routes, wp$routes), collapse = ","), ",")))
cat("\nRECORRIDOS usados:", paste(sort(toks[toks != ""]), collapse = ", "), "\n")
cat("TIPOS de punto:", paste(sort(unique(wp$tipo)), collapse = ", "), "\n")
