# 05_carbon_allometry.R
# Estimate above-ground biomass (AGB) -> carbon -> CO2e for the reserve's
# geo-referenced key trees, using a pantropical allometric equation.
# Reports point estimates AND a bootstrap confidence interval.
#
# NOTE (honest framing): we report CARBON, not "oxygen production" — carbon
# stock is the defensible metric. AGB covers only the inventoried key trees
# unless a stratified plot design is added for whole-reserve scaling.
#
# Input : inputs/inventory/key_trees.csv
#         columns: id, species, common_name, lon, lat, dbh_cm, height_m
# Output: app/public/data/carbon.json   (consumed by the Restauración view)
#
# Run:  "C:/Program Files/R/R-4.5.0/bin/Rscript.exe" data_prep/05_carbon_allometry.R

root <- normalizePath(file.path(dirname(sub("^--file=", "",
  commandArgs(FALSE)[grep("^--file=", commandArgs(FALSE))])), ".."))
csv <- file.path(root, "inputs", "inventory", "key_trees.csv")
out <- file.path(root, "app", "public", "data", "carbon.json")

# Minimal JSON writer for a flat named list (avoids a hard jsonlite dependency).
to_json <- function(x) {
  if (requireNamespace("jsonlite", quietly = TRUE))
    return(jsonlite::toJSON(x, auto_unbox = TRUE, pretty = TRUE))
  items <- vapply(names(x), function(k) {
    v <- x[[k]]
    val <- if (is.character(v)) paste0('"', v, '"')
           else if (length(v) > 1) paste0('[', paste(v, collapse = ", "), ']')
           else as.character(v)
    paste0('  "', k, '": ', val)
  }, character(1))
  paste0("{\n", paste(items, collapse = ",\n"), "\n}")
}

# --- load inventory, or a demo sample so the script runs before real data ---
if (!file.exists(csv)) {
  message("No inputs/inventory/key_trees.csv found — running with a DEMO sample.")
  set.seed(1)
  d <- data.frame(
    id = sprintf("t%02d", 1:20),
    species = sample(c("Quercus humboldtii", "Cecropia peltata", "Weinmannia pubescens",
                       "Croton magdalenensis", "Montanoa quadrangularis"), 20, TRUE),
    dbh_cm = round(runif(20, 10, 45), 1),
    height_m = round(runif(20, 6, 22), 1)
  )
  demo <- TRUE
} else {
  d <- read.csv(csv, stringsAsFactors = FALSE)
  demo <- FALSE
}

# Wood density (g/cm3) by species; fallback to a montane-forest mean of 0.60.
wd <- c("Quercus humboldtii" = 0.70, "Cecropia peltata" = 0.30,
        "Weinmannia pubescens" = 0.66, "Croton magdalenensis" = 0.45,
        "Montanoa quadrangularis" = 0.34)
d$wd <- ifelse(d$species %in% names(wd), wd[d$species], 0.60)

# Chave et al. (2014) pantropical model WITH height:
#   AGB (kg) = 0.0673 * (wd * dbh^2 * H)^0.976
d$agb_kg <- 0.0673 * (d$wd * d$dbh_cm^2 * d$height_m)^0.976
carbon_kg <- d$agb_kg * 0.47          # IPCC carbon fraction
co2e_kg   <- carbon_kg * 44 / 12      # C -> CO2 equivalent

# Bootstrap 95% CI on the CO2e total (resample trees).
boot_tot <- replicate(2000, sum(sample(co2e_kg, replace = TRUE)))
ci <- as.numeric(quantile(boot_tot, c(0.025, 0.975)))

res <- list(
  note = if (demo) "DEMO DATA — replace inputs/inventory/key_trees.csv" else "field inventory",
  n_trees = nrow(d),
  agb_total_kg = round(sum(d$agb_kg)),
  carbon_total_kg = round(sum(carbon_kg)),
  co2e_total_t = round(sum(co2e_kg) / 1000, 2),
  co2e_ci_t = round(ci / 1000, 2),
  method = "Chave et al. 2014 pantropical (with height); C fraction 0.47; CO2e x44/12; 95% CI by tree bootstrap (2000 reps)"
)
dir.create(dirname(out), showWarnings = FALSE, recursive = TRUE)
writeLines(to_json(res), out)
cat("Wrote", out, "\n")
cat(sprintf("n=%d trees | AGB=%.0f kg | CO2e=%.2f t (95%% CI %.2f–%.2f)\n",
    res$n_trees, res$agb_total_kg, res$co2e_total_t, res$co2e_ci_t[1], res$co2e_ci_t[2]))
