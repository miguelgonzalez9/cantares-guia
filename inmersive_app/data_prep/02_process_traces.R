# 02_process_traces.R
# Convert GPS trail traces (GPX from the owner's phone) into the app's
# trails.geojson, tagged by theme. Run this once the real senderos are walked.
#
# Input : inputs/traces/*.gpx   (one GPX track per sendero)
# Output: app/public/data/trails.geojson
#
# Naming convention for GPX files (so themes are auto-assigned):
#   agua_<n>.gpx  arboles_<n>.gpx  aves_<n>.gpx  restauracion_<n>.gpx
#   (or set the theme manually in the `theme_from_name` map below)
#
# Run:  "C:/Program Files/R/R-4.5.0/bin/Rscript.exe" data_prep/02_process_traces.R

suppressPackageStartupMessages(library(sf))

root <- normalizePath(file.path(dirname(sub("^--file=", "",
  commandArgs(FALSE)[grep("^--file=", commandArgs(FALSE))])), ".."))
gpx_dir <- file.path(root, "inputs", "traces")
out <- file.path(root, "app", "public", "data", "trails.geojson")

if (!dir.exists(gpx_dir) || length(list.files(gpx_dir, "\\.gpx$")) == 0) {
  stop("No GPX files in inputs/traces/. Walk the senderos with a GPX logger first.")
}

theme_from_name <- function(f) {
  b <- tolower(basename(f))
  if (grepl("agua", b)) "agua"
  else if (grepl("arbol", b)) "arboles"
  else if (grepl("ave", b)) "aves"
  else if (grepl("restaur", b)) "restauracion"
  else "general"
}

files <- list.files(gpx_dir, "\\.gpx$", full.names = TRUE)
tracks <- lapply(files, function(f) {
  # GPX "tracks" layer holds the recorded path
  tr <- tryCatch(st_read(f, layer = "tracks", quiet = TRUE), error = function(e) NULL)
  if (is.null(tr) || nrow(tr) == 0) return(NULL)
  tr <- st_zm(tr)                       # drop Z/M
  tr <- st_transform(tr, 4326)
  tr <- st_cast(tr, "LINESTRING", warn = FALSE)
  # simplify slightly to shrink file (tolerance ~ 2 m in degrees)
  tr <- st_simplify(tr, dTolerance = 0.00002, preserveTopology = TRUE)
  data.frame(
    id = tools::file_path_sans_ext(basename(f)),
    name = tools::file_path_sans_ext(basename(f)),
    theme = theme_from_name(f),
    geometry = st_geometry(tr)[1]
  ) |> st_as_sf()
})
tracks <- do.call(rbind, Filter(Negate(is.null), tracks))
tracks$themes <- as.list(tracks$theme)   # app expects a `themes` array

if (file.exists(out)) file.remove(out)
st_write(tracks, out, driver = "GeoJSON", quiet = TRUE)
cat("Wrote", nrow(tracks), "trails to", out, "\n")
print(st_drop_geometry(tracks)[c("id", "theme")])
