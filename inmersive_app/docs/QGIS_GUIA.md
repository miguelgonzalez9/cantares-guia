# Guía QGIS — crear senderos, puntos clave y la ortofoto web

Esta guía es para que **tú** crees/corrijas los datos del mapa con precisión, sobre
tu propia ortofoto. Todo se guarda como **GeoJSON en EPSG:4326 (WGS84)** dentro de
`inmersive_app/app/public/data/`. La app los lee directamente — no hay que compilar nada.

Las capas actuales (`trails.geojson`, `waypoints.geojson`) son **aproximadas** (derivadas
automáticamente del PDF y del footprint). Aquí las reemplazas por las reales.

---

## 0. Preparar QGIS (capas de referencia)

1. Abre **QGIS** (versión reciente; su GDAL sí lee ECW).
2. Arrastra a QGIS, desde `inmersive_app/inputs/maps/shapes_ortofoto/`:
   - `Ortofoto_Cantares.ecw` (la foto aérea de fondo — asegúrate que el `.eww` esté al lado).
   - `limite_predial.shp`, `Zona_conservacion.shp`, `uso intensivo.shp`, etc. (referencia).
3. Arrastra también, desde `inmersive_app/app/public/data/`, las capas actuales
   `trails.geojson` y `waypoints.geojson` para ver lo que hay y corregirlo.
4. Fija el CRS del proyecto en **EPSG:4326** (abajo a la derecha → clic en el código → busca 4326).
   *No es obligatorio, pero al exportar SIEMPRE elige 4326.*

---

## 1. Crear los SENDEROS (líneas)

Un "sendero" es una **línea**. La dirección de la línea (orden en que la dibujas) es
la dirección del recorrido: **primer clic = inicio, último = fin**.

1. Menú **Capa → Crear capa → Capa GeoPackage nueva…** (o "Shapefile nuevo").
   - Tipo de geometría: **Línea (LineString)**.
   - CRS: **EPSG:4326**.
   - Añade estos **campos** (Campo → Añadir, tipo *Texto*):
     - `id` (texto, ej. `t1`, `t2`…)
     - `name` (texto, opcional — nombre del sendero)
     - `routes` (texto — a qué recorridos pertenece, ver abajo)
2. Clic derecho en la capa → **Alternar edición** (el lápiz).
3. Herramienta **Añadir línea**: traza cada tramo de sendero sobre la ortofoto,
   clic por clic, desde el inicio hasta el fin; clic derecho para terminar el tramo.
4. Al terminar cada línea, QGIS pide los atributos → rellena `id`, `name`, `routes`.

### El campo `routes` (clave para el resaltado)

Cuando el visitante elige un **recorrido** (agua / aves / arboles / restauracion),
la app **ilumina** los senderos cuyo `routes` contiene ese recorrido. Un mismo
sendero puede pertenecer a varios. Escribe los ids **separados por coma, sin espacios**:

```
agua
aves,arboles
arboles
restauracion
```

(Ids válidos: `agua`, `aves`, `arboles`, `restauracion`. Un tramo sin recorrido = déjalo vacío;
igual se ve como sendero gris, solo que no se ilumina en ningún recorrido.)

> La app internamente separa `routes` por coma. Si prefieres, en QGIS puedes crear
> `routes` como campo de texto y escribir `agua,aves`. Al exportar a GeoJSON quedará
> como texto; la app lo entiende igual. *(Si sabes usar listas JSON, también sirve.)*

5. **Guardar exportando**: clic derecho en la capa → **Exportar → Guardar objetos como…**
   - Formato: **GeoJSON**.
   - CRS: **EPSG:4326**.
   - Nombre de archivo: `…/inmersive_app/app/public/data/trails.geojson` (reemplaza el existente).
   - Acepta. Listo — la app ya muestra tus senderos.

---

## 2. Crear los PUNTOS CLAVE (puntos)

1. **Capa → Crear capa → Capa GeoPackage nueva…**
   - Tipo: **Punto**. CRS: **EPSG:4326**.
   - Campos (todos *Texto* salvo `keypoint` que es *Texto* con `true`/`false`):
     - `id` (ej. `cascadas`, `vivero`)
     - `name`, `title` (nombre visible en español)
     - `title_en` (nombre en inglés)
     - `description`, `description_en` (texto de la ficha, ES / EN)
     - `routes` (a qué recorridos pertenece: `agua`, `aves,arboles`, o vacío)
     - `keypoint` (`true` = punto clave del recorrido; `false` = punto de referencia
       tipo casa/mirador que se ve siempre)
     - `species_ids` (opcional — especies asociadas, ids separados por coma:
       `roble,yarumo`; ver los ids en `data/species.json`)
2. **Alternar edición** → herramienta **Añadir punto** → clic exacto sobre la ortofoto
   en cada sitio → rellena los atributos.
3. **Exportar → Guardar objetos como… → GeoJSON → EPSG:4326** a
   `…/app/public/data/waypoints.geojson`.

**Reglas rápidas:**
- Punto clave de un recorrido (cascada, vivero, jardín de colibríes…): `keypoint=true`,
  `routes=<ese recorrido>`.
- Referencia general (Casa, Entrada, Miradores): `keypoint=false`, `routes` vacío → se ve siempre.
- El **inicio/fin** del recorrido lo calcula la app a partir de los extremos de las
  líneas; el punto de "Entrada" (`id=portada`) ayuda a fijar cuál extremo es el inicio.

---

## 3. La ORTOFOTO como capa del mapa (ECW → tiles web)

Tu `Ortofoto_Cantares.ecw` (~4,4 cm/píxel) no la puede leer la app directamente.
Conviértela una vez a **PMTiles** (un solo archivo, sin servidor):

### 3a. ECW → GeoTIFF (en QGIS)
Capa ortofoto → clic derecho → **Exportar → Guardar como…**
- Formato: **GeoTIFF**.
- CRS: **EPSG:3857** (Web Mercator — es el de los mapas web).
- Parámetros avanzados → opciones de creación: `COMPRESS=JPEG`, `PHOTOMETRIC=YCBCR`, `TILED=YES`.
- Guarda como `Ortofoto_Cantares.tif`.

### 3b. GeoTIFF → PMTiles (dos opciones)
**Opción sin programar (QGIS):**
1. **Caja de herramientas → Raster tools → "Generate XYZ tiles (MBTiles)"**: extensión = la
   ortofoto, zoom min ~14, max ~21, formato JPG → guarda `Ortofoto_Cantares.mbtiles`.
2. Convierte a PMTiles con el conversor web (sin subir a ningún servidor, corre en tu navegador):
   **https://neatogeo.com/tool/mbtiles_to_pmtiles/** → arrastra el `.mbtiles`, descarga el `.pmtiles`.
   *(o instala el CLI `pmtiles` de https://github.com/protomaps/go-pmtiles/releases y corre
   `pmtiles convert Ortofoto_Cantares.mbtiles Ortofoto_Cantares.pmtiles`)*

**Opción con Python:** `pip install rio-pmtiles` y luego
`rio pmtiles Ortofoto_Cantares.tif ortho.pmtiles --format WEBP --tile-size 512`.

### 3c. Poner el archivo en la app
Guarda el resultado como `…/app/public/tiles/ortho.pmtiles`.
Avísame (o edita `js/app.js`): añado la ortofoto como una opción más del **deslizador de
imagen satelital** (queda "Ortofoto" al final del slider). El código ya trae `pmtiles.js`
vendorizado; solo falta registrar el protocolo y añadir la fuente
`{ type:'raster', url:'pmtiles://tiles/ortho.pmtiles' }`.

---

## 4. Comprobar tu trabajo

- Corre la app localmente: `cd inmersive_app/app && python -m http.server 5173 --directory public`
  y abre `http://127.0.0.1:5173/`.
- En el celular (misma wifi): `http://<IP-de-tu-PC>:5173/` — ahí ves el mapa y el GPS reales.
- Elige un recorrido: deben iluminarse tus senderos de ese recorrido, con flechas de
  dirección, punto verde (inicio) y rojo (fin), y los puntos clave.
- Mueve el deslizador de imagen satelital (2019 → 2025 → HD) para ver el cambio del bosque.

## 5. Dónde queda cada cosa (resumen)

| Archivo | Qué es | Cómo se crea |
|---|---|---|
| `app/public/data/trails.geojson` | Senderos (líneas + `routes`) | QGIS, sección 1 |
| `app/public/data/waypoints.geojson` | Puntos clave + referencias | QGIS, sección 2 |
| `app/public/tiles/ortho.pmtiles` | Ortofoto para el mapa | QGIS + conversión, sección 3 |
| `app/public/data/species.json` | Inventario de especies | ya generado; edita a mano si quieres |

Todo en **EPSG:4326** (salvo la ortofoto, en 3857). Nada más que compilar.
