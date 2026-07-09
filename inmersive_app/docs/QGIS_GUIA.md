# Guía QGIS — crear senderos, puntos clave y la ortofoto web

Para que **tú** crees/corrijas los datos del mapa con precisión, sobre tu ortofoto.
Todo se guarda como **GeoJSON en EPSG:4326 (WGS84)** en `inmersive_app/app/public/data/`.
La app los lee directo — no hay que compilar nada.

Las capas actuales (`trails.geojson`, `waypoints.geojson`) son **aproximadas** (auto-derivadas
del PDF y del footprint). Aquí las reemplazas por las reales.

---

## ⚠️ Antes de empezar — 3 cosas que evitan que pierdas el trabajo

1. **No vuelvas a correr los scripts `07_pdf_to_content.py` ni `09_trail_centerlines.py`
   después de crear tus datos** — sobrescriben `trails.geojson` y `waypoints.geojson`.
   Una vez son tuyos, edítalos solo en QGIS.
2. **Exporta SIEMPRE en EPSG:4326.** Si trazas sobre la ortofoto (que está en otro sistema),
   los datos quedan bien igual, siempre que al *Guardar como…* elijas **CRS = EPSG:4326**.
   Si no, los puntos aparecen en medio del océano.
3. **Caché del navegador (service worker):** al reemplazar un GeoJSON, la app muestra la
   versión vieja la **primera** vez y la nueva en la **segunda** recarga. Para ver el cambio
   ya: recarga dos veces, o abre en ventana de incógnito, o en DevTools (F12) → *Application →
   Service Workers → Unregister* y recarga.

---

## 0. Preparar QGIS

1. Abre **QGIS** (versión reciente; su GDAL sí lee ECW).
2. Arrastra desde `inputs/maps/shapes_ortofoto/`:
   - `Ortofoto_Cantares.ecw` (foto aérea de fondo — el `.eww` debe estar al lado).
   - `limite_predial.shp`, `Zona_conservacion.shp`, etc. (referencia de zonas).
3. Arrastra desde `app/public/data/` las capas actuales `trails.geojson` y `waypoints.geojson`
   para verlas y corregirlas.

---

## 1. Crear los SENDEROS (líneas)

Un sendero es una **línea**. El **orden en que la dibujas es la dirección**:
primer clic = inicio, último clic = fin.

1. **Capa → Crear capa → Capa GeoPackage nueva…**
   - Geometría: **Línea (LineString)** · CRS: **EPSG:4326**.
   - Campos (todos tipo **Texto**):
     - `id` — identificador **único** (ej. `t1`, `t2`…). *Que no se repita.*
     - `name` — nombre del sendero (opcional).
     - `routes` — a qué recorridos pertenece (ver abajo).
2. Clic derecho → **Alternar edición** (lápiz) → herramienta **Añadir línea** → traza cada
   tramo sobre la ortofoto (clic por clic, clic derecho para terminar) → rellena los campos.

### El campo `routes` (esto es lo que hace el resaltado)

Al elegir un **recorrido** (`agua`, `aves`, `arboles`, `restauracion`), la app **ilumina**
los senderos cuyo `routes` contiene ese recorrido. Un tramo puede estar en varios.

**Escríbelo como texto separado por comas** (así lo exporta QGIS y la app lo entiende):

```
agua
aves,arboles
arboles
```

- Ids válidos: **`agua`, `aves`, `arboles`, `restauracion`** (sin tildes, minúscula).
- Tramo sin recorrido → deja el campo **vacío**; se ve como sendero gris, no se ilumina.
- **NO uses formato JSON** (`["agua"]`) en el campo de texto — solo la lista con comas: `agua,aves`.

### Conectar tramos (autoensamblado / snapping)

**No necesitas una sola línea continua.** La app maneja el sendero como varios tramos;
sólo hace falta que los extremos se toquen (y cada tramo puede tener su propio `routes`).

Para que los extremos se "peguen" solos:
1. **Ver → Barras de herramientas → Autoensamblado** (icono de **imán**). Actívalo.
2. Configura al lado: modo **Todas las capas**, tipo **Vértice y segmento**, tolerancia ~12 px.
   Activa también **Edición topológica** (icono a la derecha del imán).
3. Al dibujar verás un **cuadro magenta** sobre los vértices existentes = ahí se ensambla.

- **Tramo nuevo pegado a uno existente:** con *Añadir línea*, haz el **primer clic sobre el
  extremo** de la línea existente (espera el cuadro magenta) y sigue trazando.
- **Pegar una línea que ya dibujaste:** usa la **Herramienta de Vértices** (barra de
  Digitalización) → clic en el vértice del extremo de tu línea → arrástralo al extremo de la
  otra línea (cuadro magenta) → clic para soltar → **Ctrl+S**.
- **Fusionar en un solo objeto** (rara vez necesario): selecciona ambas líneas →
  *Editar → Editar geometría → Fusionar objetos seleccionados*.

### Modelo mental: tramos + etiquetas (NO un objeto por recorrido)

Un **recorrido NO es una geometría aparte**. Es *"todos los tramos etiquetados con ese
recorrido"* en el campo `routes`. Así, un tramo compartido puede estar en varios recorridos
(`agua,aves`) sin duplicar geometría.

**Fragmentar la red en tramos:**
- Traza cada tramo como una línea separada entre cruces (con el imán) — es lo más limpio; o
- **Dividir objetos (Split Features)** para cortar una línea existente en un cruce; o
- **Vector → Herramientas de geometría → Partes múltiples a partes simples** si es multiparte.

**"Crear un recorrido" = etiquetar un subconjunto:**
1. Con la herramienta de **Selección**, marca los tramos de ese recorrido (Shift-clic / por área).
2. **Calculadora de campos** (ábaco) → marca **"Actualizar sólo los objetos seleccionados"** →
   **Actualizar campo existente: `routes`** → expresión (añade sin borrar):
   ```
   if("routes" is null OR "routes" = '', 'agua', "routes" || ',agua')
   ```
3. Repite por cada recorrido (`aves`, `arboles`, `restauracion`) con su subconjunto.
   Córrela **una sola vez por recorrido** (dos veces con la misma etiqueta la duplica).

4. **Guardar:** clic derecho en la capa → **Exportar → Guardar objetos como…**
   → Formato **GeoJSON** → CRS **EPSG:4326** → archivo
   `…/app/public/data/trails.geojson` (reemplaza el existente).

---

## 2. Crear los PUNTOS CLAVE (puntos)

1. **Capa → Crear capa → Capa GeoPackage nueva…** → **Punto** · **EPSG:4326**.
   - Campos (tipo **Texto**):
     - `id` — único (ej. `cascadas`, `vivero`).
     - `title` — nombre visible en español · `title_en` — en inglés.
     - `description` / `description_en` — texto de la ficha (ES / EN).
     - `routes` — recorridos a los que pertenece (`agua`, `aves,arboles`, o **vacío**).
     - `species_ids` — especies asociadas, ids con coma: `roble,yarumo`
       (los ids están en `data/species.json`). Opcional.
     - `photo` — opcional; ver "Fotos" abajo.
2. **Alternar edición** → **Añadir punto** → clic exacto sobre la ortofoto → rellena campos.
3. **Exportar → Guardar objetos como… → GeoJSON → EPSG:4326** →
   `…/app/public/data/waypoints.geojson`.

**Reglas de visibilidad (importante):** lo que decide si un punto se ve es el campo `routes`:
- `routes` con un recorrido (ej. `agua`) → el punto aparece **solo** cuando se elige ese recorrido.
- `routes` **vacío** → punto de referencia (Casa, Entrada, Miradores) que se ve **siempre**.
- El punto de entrada conviene que tenga `id = portada`: la app lo usa para decidir cuál
  extremo del recorrido es el **inicio** (verde) y cuál el **fin** (rojo).

**Fotos (opcional):** copia la imagen a `app/public/img/` y pon en el campo `photo` la ruta
relativa, ej. `img/cascadas.jpg`. La app la muestra en la ficha del punto.

---

## 3. La ORTOFOTO como capa del mapa (ECW → tiles web)

Tu `Ortofoto_Cantares.ecw` (~4,4 cm/píxel) no la lee la app directo. Conviértela **una vez**
a **PMTiles** (un solo archivo, sin servidor).

### 3a. ECW → GeoTIFF (en QGIS)
Capa ortofoto → clic derecho → **Exportar → Guardar como…**
- Formato **GeoTIFF** · CRS **EPSG:3857** (Web Mercator).
- Parámetros avanzados → opciones de creación: `COMPRESS=JPEG`, `PHOTOMETRIC=YCBCR`, `TILED=YES`.
- Guarda `Ortofoto_Cantares.tif`.

### 3b. GeoTIFF → PMTiles
**Sin programar (QGIS):**
1. **Caja de herramientas → "Generate XYZ tiles (MBTiles)"**: extensión = la ortofoto,
   zoom min ~14, **max ~19–20** (más zoom infla mucho el archivo y no aporta a 31 ha),
   formato JPG → `Ortofoto_Cantares.mbtiles`.
2. Conviértelo con el conversor web (corre en tu navegador, no sube nada):
   **https://neatogeo.com/tool/mbtiles_to_pmtiles/** → arrastra el `.mbtiles`, descarga `.pmtiles`.

**Con Python:** `pip install rio-pmtiles` → `rio pmtiles Ortofoto_Cantares.tif ortho.pmtiles --format WEBP --tile-size 512`.

### 3c. Ponerlo en la app — ya está cableado
Guarda el archivo como **`…/app/public/tiles/ortho.pmtiles`** (crea la carpeta `tiles/`).
**No hay que tocar código:** la app detecta el archivo al abrir y añade **"Ortofoto"** como
última opción del **deslizador de imagen satelital**. (Verifícalo antes en https://pmtiles.io
arrastrando tu `.pmtiles` — debe caer sobre Manizales.)

---

## 4. Comprobar

- Local: `cd inmersive_app/app && python -m http.server 5173 --directory public` → `http://127.0.0.1:5173/`.
- Celular (misma wifi): `http://<IP-de-tu-PC>:5173/` — ahí ves mapa y GPS reales.
- Elige un recorrido → deben iluminarse tus senderos de ese recorrido, con flechas de dirección,
  punto verde (inicio) y rojo (fin), y los puntos clave.
- Mueve el deslizador (2019 → 2025 → HD → Ortofoto) para ver el cambio del bosque.
- Si no ves tus cambios, recuerda la **caché** (⚠️ punto 3 arriba): recarga dos veces.

## 5. Resumen — dónde va cada cosa

| Archivo | Qué es | Cómo se crea | CRS |
|---|---|---|---|
| `app/public/data/trails.geojson` | Senderos (líneas + `routes`) | QGIS, §1 | 4326 |
| `app/public/data/waypoints.geojson` | Puntos clave + referencias | QGIS, §2 | 4326 |
| `app/public/tiles/ortho.pmtiles` | Ortofoto del mapa | QGIS + conversión, §3 | 3857 |
| `app/public/img/*.jpg` | Fotos de los puntos | copiar a mano | — |
| `app/public/data/species.json` | Inventario de especies | ya generado; editable | — |

## 6. Créditos / licencias de las imágenes (para publicar)

- **Esri World Imagery** ("Actual (HD)" y el histórico): requiere el crédito
  *"Esri, Maxar, Earthstar Geographics"* (ya sale en el mapa).
- **Sentinel-2 cloudless de EOX** (años 2019–2025): licencia **CC BY-NC-SA 4.0 = no comercial**.
  Para difusión de la reserva está bien; si en algún momento el sitio se vuelve **comercial**
  (venta de tours, etc.), hay que quitar esas capas o pedir a EOX una licencia comercial.
- **Tu ortofoto** es tuya — sin restricciones.
