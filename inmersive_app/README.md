# Cantares — Guía interactiva de la reserva

Progressive Web App (offline, instalable) + tubería de datos en R para la
**Reserva Natural Cantares** (RNSC 112-20, 31,07 ha, Manizales). Tres pilares:

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
  data_prep/         # R (sf/terra/rgee) — genera los datos que consume la app
    01_reproject_zones.R   ✅ límite 9377→4326  (corre; 31,07 ha verificadas)
    02_process_traces.R    ✅ GPX → trails.geojson (listo para los trazados reales)
    03_ndvi_timeseries.R   ⧗ plantilla (necesita rgee/Earth Engine + zonas)
    04_ortho_tiles.R       ⧗ plantilla (necesita la ortofoto GeoTIFF)
    05_carbon_allometry.R  ✅ inventario → carbon.json (corre con datos demo)
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
| 1 Recorridos | UI, GPS `watchPosition`, cercanía, filtros temáticos, mapa MapLibre + límite | trazados GPS reales + puntos/fotos del propietario (muestra por ahora) |
| 2 Restauración | tarjeta de carbono en vivo (demo), paneles NDVI/ortofoto | ortofoto GeoTIFF, inventario de árboles, digitalizar las 5 zonas |
| 3 Especies | catálogo 62 spp, filtros, enlaces Pl@ntNet/Merlin/iNat, inventario | proyecto iNaturalist "Cantares"; fotos por especie |

**Verificado** (Chrome, este build): catálogo de especies renderiza; filtros
62→8; navegación por pestañas; carga de datos (zonas 31,07 ha, 8 puntos, 62
especies, 4 recorridos); tarjeta de carbono 11,36 t CO₂e. El **mapa MapLibre no
se pudo verificar visualmente** en el navegador de automatización (WebGL por
software se congela); el código y los datos son correctos — **probar en un
celular real**.

## Hallazgo importante

El shapefile entregado es **solo el límite** del predio (1 polígono, campos
RUNAP), **no** las 5 zonas de manejo. La zonificación (Conservación/Restauración/…)
existe únicamente como mapa (Figura 1 de la resolución). Para las capas de zonas
hay que **digitalizarlas** (trazar en sitio o georreferenciar la Figura 1) →
`inputs/maps/zones_5.geojson`.

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
