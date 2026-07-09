# Cantares — Guía interactiva de la reserva

Progressive Web App (offline, instalable, **bilingüe ES/EN**) + tubería de datos
en R/Python para la **Reserva Natural Cantares** (RNSC 112-20, 31,07 ha, Manizales).
Botón de idioma en el encabezado. Tres pilares:

1. **Recorridos** — senderos temáticos (agua / árboles / aves / restauración) con
   GPS en vivo y fichas de puntos clave que aparecen por cercanía.
2. **Restauración** — reverdecimiento (NDVI), antes/después con ortofoto, y
   carbono capturado por alometría (no "oxígeno" — métrica no defendible).
3. **Especies** — catálogo + identificación (Pl@ntNet Andes / Merlin / BirdNET) que
   alimenta un inventario verificable (iNaturalist → GBIF/SiB Colombia).

## Estructura

```
inmersive_app/
  inputs/            # insumos crudos (resolución PDF, shapefile del límite)
  data_prep/         # R (sf) + Python (fitz/PIL) — genera los datos de la app
    01_reproject_zones.R   ✅ límite RUNAP 9377→4326 (corre; 31,07 ha)
    02_process_traces.R    ✅ GPX → trails.geojson (para trazados GPS futuros)
    03_ndvi_timeseries.R   ⧗ plantilla (necesita rgee/Earth Engine)
    04_ortho_tiles.R       ⧗ plantilla (necesita ortofoto GeoTIFF — ver ECW abajo)
    05_carbon_allometry.R  ✅ inventario → carbon.json (corre con datos demo)
    06_process_ortofoto_layers.R  ✅ shapes_ortofoto 3116→4326: boundary/zones/caminos
    07_pdf_to_content.py   ✅ ortofoto_caminos.pdf → senderos+POIs reales + mapa PNG (ES/EN)
    08_add_species_en.py   ✅ nombres comunes en inglés para species.json
  app/public/        # la PWA (sin build; HTML/CSS/JS + librerías vendorizadas)
    index.html  css/  js/app.js  sw.js  manifest.webmanifest  icons/
    vendor/     # maplibre-gl + pmtiles (offline)
    data/       # zones.geojson, trails.geojson, waypoints.geojson,
                # routes.json, species.json (62 spp), carbon.json
```

## Correr localmente

```bash
cd inmersive_app/app
python -m http.server 5173 --directory public   # o: npm run serve
# abrir http://127.0.0.1:5173/
```

`?nomap=1` desactiva el mapa WebGL (dispositivos sin WebGL / pruebas).

## Estado (implementado vs. pendiente de insumos)

| Pilar | Hecho | Pendiente |
|---|---|---|
| 1 Recorridos | UI ES/EN, GPS robusto, cercanía, **6 senderos reales + 12 POIs reales**, mapa con **límite + 4 zonas + red de caminos** reales | trazados GPS por sendero (POIs en posición aproximada); fotos/audio por punto |
| 2 Restauración | carbono en vivo (demo), paneles NDVI/ortofoto, **mapa ilustrado de senderos** | convertir ECW→GeoTIFF (abajo), NDVI, inventario de árboles |
| 3 Especies | catálogo 62 spp ES/EN, filtros, enlaces Pl@ntNet/Merlin/iNat | proyecto iNaturalist "Cantares"; fotos por especie |

**Verificado** (Chrome, este build): toggle ES/EN completo (pestañas, filtros,
especies, senderos); nombres de senderos completos en los chips; catálogo 62
especies con nombres en inglés; carga de las 4 capas geo reales; sin errores JS;
tarjeta de carbono 11,36 t CO₂e. El **render del mapa MapLibre no se puede ver**
en el navegador de automatización (WebGL por software se congela) — código y
datos correctos, **probar en un celular real** para ver mapa + GPS.

## Insumos del propietario ya integrados

`shapes_ortofoto/` (EPSG:3116) y `ortofoto_caminos.pdf` fueron procesados:
- **límite, zonas de manejo (conservación, uso intensivo, agroecosistema,
  transición) y red de caminos** → capas reales del mapa (script 06).
- **6 senderos reales** (Las Aguas, Las Cascadas, Los Encenillos, Helechos y
  Orquídeas, Tororoi, La Cabaña) y **12 POIs reales** (miradores, cabaña, vivero,
  arboretum, jardín de colibríes, cascadas…) del PDF (script 07). *Las posiciones
  de los POIs son aproximadas (afín desde el PDF) hasta el trazado GPS real.*
- El PDF se rasterizó a `img/mapa_senderos.png` (mapa ilustrado en la app).
- Nota: la zonificación de estos shapes (2020) difiere de la Res.201/2021.

## Pendiente: la ortofoto (ECW)

`Ortofoto_Cantares.ecw` (~4,4 cm/píxel, WGS84) **no** se puede leer con el GDAL
instalado (ECW es propietario). Para el comparador antes/después en el mapa:
convertir a GeoTIFF/COG en **QGIS** (`Exportar → Guardar como → GTiff`) a
`inputs/ortho/cantares_ortho.tif`, luego correr `04_ortho_tiles.R`.

## Notas técnicas

- **Sin build**: la PWA es HTML/CSS/JS plano con MapLibre + PMTiles vendorizados.
  Se sirve estática (GitHub Pages / Cloudflare Pages, gratis, HTTPS).
- **Offline**: `sw.js` usa *stale-while-revalidate* (sirve del caché al instante,
  refresca en segundo plano — así las actualizaciones sí llegan). Los tiles del
  mapa se cachean a medida que se ven: abrir el mapa con wifi antes de ir al sendero.
- **Base del mapa**: satélite Esri World Imagery (en línea) → se cachea para offline.
- **CRS**: shapefile en CTM12 / EPSG:9377; la app usa WGS84/4326.

## Próximos pasos del propietario (campo)

- Trazar cada sendero con un logger GPX (OsmAnd / Organic Maps), un archivo por sendero.
- En cada punto clave: coordenada + 2–3 fotos + nota de voz de 30 s.
- Árboles clave: coordenada, especie, DAP (cinta a 1,3 m), altura, fotos → alimenta carbono y fichas.
- Confirmar la ortofoto (resolución/formato) **y si el vuelo generó DSM/DTM** (habilita detección de copas).
- Aves con Merlin (paquete Colombia); plantas con Pl@ntNet (flora Andes tropicales, descargada).
