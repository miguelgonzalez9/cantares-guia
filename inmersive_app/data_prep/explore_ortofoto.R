# explore_ortofoto.R — inspect the shapes_ortofoto inputs (run via PowerShell Rscript)
suppressPackageStartupMessages(library(sf))
d <- "C:/Users/migol/Dropbox/Cantares/inmersive_app/inputs/maps/shapes_ortofoto"
files <- c("camino","limite_predial","Zona_conservacion","uso intensivo","Agroecosistema","Transicion")
for (f in files) {
  x <- tryCatch(st_read(file.path(d, paste0(f,".shp")), quiet=TRUE), error=function(e) NULL)
  if (is.null(x)) { cat("\n===",f,"=== READ FAILED\n"); next }
  gt <- as.character(st_geometry_type(x)[1])
  cat("\n===", f, "=== EPSG:", st_crs(x)$epsg, "| geom:", gt, "| n:", nrow(x), "\n")
  cat("  fields:", paste(setdiff(names(x), attr(x,"sf_column")), collapse=", "), "\n")
  x2 <- st_transform(x, 4326)
  bb <- st_bbox(x2)
  cat("  bbox4326:", round(bb[1],5), round(bb[2],5), round(bb[3],5), round(bb[4],5), "\n")
  if (grepl("POLYGON", gt)) cat("  area_ha:", round(as.numeric(sum(st_area(x)))/10000,3), "\n")
  if (grepl("LINE", gt))    cat("  length_m:", round(as.numeric(sum(st_length(x))),1), "\n")
}
# ortho world file + projection
cat("\n=== Ortofoto_Cantares ===\n")
cat("eww:\n"); cat(readLines(file.path(d,"Ortofoto_Cantares.eww")), sep="\n"); cat("\n")
cat("prj:\n"); cat(readLines(file.path(d,"Ortofoto_Cantares.prj")), sep="\n"); cat("\n")
