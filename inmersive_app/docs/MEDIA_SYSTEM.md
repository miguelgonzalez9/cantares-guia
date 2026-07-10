# Sistema de almacenamiento y clasificación de imágenes

Cómo la app guarda, clasifica y sirve las fotos del inventario (fauna y flora) y
de los puntos clave. Objetivo: **eficiente** (repo liviano, carga rápida en el
celular, funciona offline), **fácil de alimentar** (el dueño suelta fotos sin
programar) y **con datos aprovechables** (crédito, licencia, fecha, GPS).

## Principios

1. **Originales fuera del repo.** Las fotos crudas (3–8 MB c/u) NO se versionan.
   Solo entran al repo las versiones web optimizadas (~30–150 KB). Ver `.gitignore`.
2. **La carpeta = la clasificación.** El dueño suelta cada foto en una subcarpeta
   nombrada como el `id` de la especie o el punto. Sin renombrar, sin CSV, sin UI.
3. **Un registro único.** `app/public/data/media.json` es el catálogo: qué imagen
   pertenece a qué sujeto, cuál es la principal, y sus metadatos.
4. **Progresivo.** Sin foto, la tarjeta se ve como antes (texto). Con foto,
   aparece la miniatura. Cero regresión mientras el inventario visual crece.
5. **Offline con tope.** El service worker cachea las fotos vistas en un caché
   propio limitado (350) — abrir la galería con wifi las deja listas para el sendero.

## Flujo de datos

```
  Celular/cámara (originales)
        │  el dueño los suelta en…
        ▼
  inputs/photos/incoming/{especies|puntos}/<id>/*.jpg      ← clasificación por carpeta
        │  python data_prep/10_process_photos.py
        ▼
  ├─ app/public/img/{species|waypoints}/<id>__<n>.webp     ← principal (moderno)
  ├─ app/public/img/{species|waypoints}/<id>__<n>.jpg      ← respaldo universal
  ├─ app/public/img/_thumbs/<id>__<n>.webp                 ← miniatura (grid)
  ├─ app/public/data/media.json                            ← registro actualizado
  └─ inputs/photos/_originals/{especies|puntos}/<id>/…     ← respaldo del original (gitignored)
        │  git commit + push
        ▼
  GitHub Pages sirve la PWA con las fotos
```

## Estructura de carpetas

```
inputs/photos/
  incoming/
    especies/<species_id>/    ← fotos de especies (id de species.json)
    puntos/<waypoint_id>/      ← fotos de puntos clave (id de waypoints.geojson)
    _sin_clasificar/           ← fotos sin id claro; se revisan aparte (no se procesan)
    README.md                  ← instrucciones para el dueño (no técnicas)
  _originals/                  ← respaldo full-res (gitignored)
app/public/img/
  species/  waypoints/  _thumbs/
app/public/data/media.json     ← el registro
```

## Esquema de `media.json`

Un arreglo `photos[]`; cada registro:

| Campo | Origen | Nota |
|---|---|---|
| `file` | script | ruta WebP desde `app/public/` |
| `jpg` | script | respaldo JPEG |
| `thumb` | script | miniatura WebP |
| `subject_type` | carpeta | `species` \| `waypoint` |
| `subject_id` | carpeta | id validado contra el inventario |
| `is_primary` | script/manual | una por sujeto; editable |
| `credit`, `license` | config/manual | por defecto «Reserva Natural Cantares», CC BY 4.0 |
| `caption`, `caption_en` | manual | pie de foto opcional |
| `taken` | EXIF | fecha/hora de captura |
| `lat`, `lon` | EXIF | **solo** si está dentro de la reserva y la especie no es sensible |
| `w`, `h`, `bytes` | script | dimensiones y peso |

Los campos manuales (`credit`, `license`, `caption*`, `is_primary`) **se conservan**
al re-procesar: el script re-emplaza dimensiones pero respeta lo editado a mano.

## Clasificación semántica

- **Por sujeto**: especie (id) o punto (id). La carpeta lo determina.
- **Principal vs. secundarias**: `is_primary` marca la imagen de portada de la
  tarjeta; las demás quedan como galería (uso futuro en una ficha ampliada).
- **Sensibilidad** (ética anti-saqueo): una especie con `"sensitive": true` en
  `species.json`, o de familia `Orchidaceae` (lista en el script), **no publica
  coordenadas**. El script escribe `dataGeneralizations` en lugar de `lat/lon`.
- **Validación geográfica**: si una foto de especie trae GPS **fuera** del bbox
  de la reserva, el script lo avisa (posible foto mal clasificada).

## Eficiencia (por qué estas decisiones)

- **WebP + JPEG**: WebP pesa ~30% menos; el JPEG es respaldo para navegadores viejos
  vía `<picture>`. Miniatura aparte (420 px) para el grid; principal a 1600 px.
- **Repo liviano**: a ~80 KB por imagen web, 92 especies + 15 puntos con 1–3 fotos
  cada uno ≈ 15–40 MB — cómodo para GitHub Pages (límite blando ~1 GB, 100 GB/mes
  de ancho de banda). Los originales pesados quedan fuera del repo.
- **Carga perezosa**: `loading="lazy"` — solo se descargan las miniaturas visibles.
- **Offline acotado**: caché de imágenes con tope FIFO (350) en `sw.js`, separado
  del caché de tiles del mapa y del shell.

## Uso

```bash
# 1. El dueño suelta fotos en inputs/photos/incoming/especies/<id>/ …
# 2. Procesar (dry-run para ver qué haría, sin escribir):
python inmersive_app/data_prep/10_process_photos.py --dry-run
python inmersive_app/data_prep/10_process_photos.py
# 3. Revisar el resumen (cobertura, avisos GPS, HEIC, ids desconocidos)
# 4. git add inmersive_app/app/public/img inmersive_app/app/public/data/media.json
#    git commit && git push   → GitHub Pages publica
```

**HEIC (iPhone)**: el script los detecta y avisa. Solución: en el iPhone,
*Ajustes → Cámara → Formatos → «Más compatible»* (guarda JPG), o instalar
`pip install pillow-heif` para convertirlos.

## Cómo verificar

- `--dry-run` imprime qué procesaría sin tocar archivos.
- El resumen final da **cobertura** (especies con foto / total) y **avisos**
  (ids desconocidos, GPS fuera de reserva, HEIC).
- En la app: la tarjeta de especie muestra la miniatura; la ficha del punto usa la
  foto real (si existe) en vez del marcador de color.
