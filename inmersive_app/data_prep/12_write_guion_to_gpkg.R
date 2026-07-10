# 12_write_guion_to_gpkg.R
# Escribe el contenido interpretativo (Guión interpretativo Cantares.pdf) en la
# capa `puntos_clave` del GeoPackage del propietario: rellena description /
# description_en por punto (match por título). Preserva la otra capa y el resto
# de atributos. Correr con QGIS CERRADO (bloquea el .gpkg). Vía PowerShell Rscript.
suppressPackageStartupMessages(library(sf))
d   <- "C:/Users/migol/Dropbox/Cantares/inmersive_app/app/public/data"
gpk <- file.path(d, "waypoints.gpkg")
lyr <- "puntos_clave"

# title -> (es, en). Redactado desde el guión interpretativo.
G <- list(
  "Casa" = list(
    es = "La casa principal es el corazón de Cantares y el punto de partida de los recorridos. El nombre de la reserva nace de los «cantares» del bosque: el coro de aves, ranas, grillos, vientos y cascadas que suena de día y de noche.",
    en = "The main house is the heart of Cantares and the starting point of the trails. The reserve's name comes from the «cantares» (songs) of the forest: the chorus of birds, frogs, crickets, wind and waterfalls that plays day and night."),
  "Cabaña" = list(
    es = "Desde la cabaña principal se ofrece la guianza e interpretación ambiental. Es el mejor lugar para descansar, orientarse y decidir qué sendero recorrer.",
    en = "The main cabin is the base for guided walks and environmental interpretation — the best place to rest, get your bearings and choose which trail to take."),
  "Cascada" = list(
    es = "Una de las cerca de cuatro cascadas naturales que alimentan la quebrada Olivares que, junto con la cuenca del río Blanco, abastece de agua al 35% de Manizales. En sus peñas, la humedad constante da refugio a varias especies de ranas.",
    en = "One of about four natural waterfalls feeding the Olivares creek which, together with the Río Blanco basin, supplies water to 35% of Manizales. Its constantly humid rock faces shelter several frog species."),
  "Tanques de Agua" = list(
    es = "Parte del sistema que capta el agua de las quebradas de Cantares. Toda esta cuenca alimenta el río Blanco, del que depende buena parte del agua potable de Manizales.",
    en = "Part of the system that captures water from the Cantares creeks. This whole basin feeds the Río Blanco, on which much of Manizales' drinking water depends."),
  "Mirador Nido del Águila" = list(
    es = "Desde este mirador, con paciencia, se alcanza a ver a la distancia el nido del águila crestada de montaña (Spizaetus isidori), la segunda águila más amenazada de los Andes. Comparte la cima de la cadena alimenticia con el puma.",
    en = "From this lookout, with patience, you can spot in the distance the nest of the black-and-chestnut eagle (Spizaetus isidori), the second most threatened eagle in the Andes. It shares the top of the food chain with the puma."),
  "Nido de Águila" = list(
    es = "El águila crestada de montaña (Spizaetus isidori), llamada «Guamán», anida en estas pendientes. Casi cada día una pareja y su juvenil planean sobre la reserva aprovechando las corrientes térmicas: «autopistas de aire» que reducen su esfuerzo al volar.",
    en = "The black-and-chestnut eagle (Spizaetus isidori), locally «Guamán», nests on these slopes. Almost daily a pair and their juvenile soar over the reserve riding thermals — «air highways» that let them fly with little effort."),
  "Avistamiento de un Puma" = list(
    es = "Las cámaras trampa registraron aquí al puma o león de montaña (Puma concolor), tope de la red alimenticia junto al águila crestada. Su presencia muestra por qué importa conservar los corredores biológicos de los Andes.",
    en = "Camera traps recorded the puma or mountain lion (Puma concolor) here — top of the food web alongside the crested eagle. Its presence shows why the Andes' biological corridors are worth conserving."),
  "Avistamiento Tinamú y Tucán" = list(
    es = "El tinamú leonado (Nothocercus julius), terrestre y difícil de ver, canta con fuerza al amanecer. Lo acompaña el tucán pechiazul (Andigena nigrirostris), gran dispersor de semillas del bosque montano.",
    en = "The tawny-breasted tinamou (Nothocercus julius), a shy ground bird, sings loudly at dawn. Alongside it, the grey-breasted mountain toucan (Andigena nigrirostris) is a key seed disperser of the montane forest."),
  "Comederos de Aves" = list(
    es = "Los comederos y el jardín de flores tradicionales de la región concentran la actividad de las aves. Aquí se han registrado más de 16 especies de colibríes, entre ellas el rumbito pechiblanco (Chaetocercus mulsant), el colibrí más pequeño de Colombia.",
    en = "The feeders and the garden of traditional regional flowers draw intense bird activity. Over 16 hummingbird species have been recorded here, including the white-bellied woodstar (Chaetocercus mulsant), Colombia's smallest hummingbird."),
  "Jardin de los Colibríes" = list(
    es = "Un jardín ornamentado con flores que tradicionalmente decoran las fincas de la región —fucsias, abutilones, verbenas, zarcillos— y que atraen a las más de 16 especies de colibríes registradas en la reserva.",
    en = "A garden of flowers that traditionally adorn the region's farms —fuchsias, abutilons, verbenas— attracting the 16-plus hummingbird species recorded in the reserve."),
  "Vivero" = list(
    es = "El invernadero funciona como «laboratorio» para reproducir in situ la flora nativa de la zona. Es el motor de la reforestación activa que vincula al visitante con la conservación.",
    en = "The greenhouse works as a «laboratory» to propagate the area's native flora in situ. It powers the active reforestation that connects visitors to conservation."),
  "Bosque de Sietecueros" = list(
    es = "Un bosque dominado por el sietecueros (Andesanthus lepidotus, antes Tibouchina lepidota), de flores moradas. Aquí se siembran árboles nativos como el pino colombiano (Retrophyllum rospigliosii), el roble andino (Quercus humboldtii) y la palma de cera quindiana (Ceroxylon quindiuense).",
    en = "A forest dominated by the purple-flowered sietecueros (Andesanthus lepidotus, formerly Tibouchina lepidota). Native trees are planted here — Colombian pine (Retrophyllum rospigliosii), Andean oak (Quercus humboldtii) and the Quindío wax palm (Ceroxylon quindiuense)."),
  "Mirador 1" = list(
    es = "Un balcón sobre la reserva. El paisaje de Cantares es una «huella en el tiempo» que evidencia la restauración de suelos, bosques y fuentes de agua.",
    en = "A balcony over the reserve. The Cantares landscape is a «footprint in time» that shows the restoration of soils, forests and water sources."),
  "Mirador 2" = list(
    es = "Otro punto para contemplar la cuenca. Al atardecer suelen pasar bandadas de palomas collarejas (Patagioenas fasciata), a veces de más de 100 individuos.",
    en = "Another spot to take in the watershed. At dusk, flocks of band-tailed pigeons (Patagioenas fasciata) often pass by, sometimes more than 100 birds."),
  "Mirador 3 Cuidad de Manizales" = list(
    es = "Desde aquí se abre la vista hacia la ciudad de Manizales. El mirador conecta el bosque en recuperación de Cantares con el paisaje urbano que depende de su agua.",
    en = "This lookout opens toward the city of Manizales, linking the recovering forest of Cantares with the urban landscape that depends on its water."),
  "Avistamiento Rana de Chocolate" = list(
    es = "La rana de la cordillera central (Hyloscirtus larinopygion) vive ligada a las quebradas de aguas limpias y frías. La humedad constante del bosque y las cascadas son su refugio.",
    en = "The central cordillera tree frog (Hyloscirtus larinopygion) lives tied to clean, cold streams. The forest's constant humidity and the waterfalls are its refuge.")
)

w <- st_read(gpk, layer = lyr, quiet = TRUE)
if (!"description" %in% names(w))    w$description    <- NA_character_
if (!"description_en" %in% names(w)) w$description_en <- NA_character_

n_set <- 0
for (i in seq_len(nrow(w))) {
  ttl <- as.character(w$title[i])
  g <- G[[ttl]]
  if (!is.null(g)) { w$description[i] <- g$es; w$description_en[i] <- g$en; n_set <- n_set + 1 }
  else cat("  sin guión (revisar título):", ttl, "\n")
}

st_write(w, gpk, layer = lyr, delete_layer = TRUE, quiet = TRUE)
cat("Escritos", n_set, "de", nrow(w), "puntos en la capa", lyr, "\n")
