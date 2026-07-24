# Sistema de Información Cantares (SIC)

Un sistema **centrado en Dropbox** para que la reserva guarde, categorice y
encuentre su información — fotos y documentos — sin programar, y que se conecte
con la web-app en **dos vías**. Todo se procesa con scripts locales de Python que
corren solos de forma **periódica** (Programador de Tareas de Windows).

```
                 ┌───────────────── DROPBOX / Cantares ─────────────────┐
                 │                                                       │
 (admin deja) →  │  inputs/photos/incoming/{especies,puntos,             │  10_process_photos.py
                 │       senderos,recorridos}/<id>/  ──────────────────► │  → app/public/img/... + media.json
                 │                                                       │
 (juego) ──────► │  inputs/photos/field/_incoming/*.json  ─────────────► │  13_ingest_game_photos.py
                 │       (respaldo de la app)                            │  → field/<especie>/ + avistamientos_juego.csv
                 │                                                       │
 (admin deja) →  │  info/_inbox/  ─────────────────────────────────────► │  12_build_doc_catalog.py
                 │       (documentos sueltos)                            │  → info/<categoria>/ + INDEX.md + catalog.json
                 └───────────────────────────────────────────────────────┘
                         run_sic.py  (orquesta los 3)  ← CantaresSIC (cada 4 h, Task Scheduler)
```

---

## 1. Fotos — flujo de doble vía

### 1.0 Entrada principal (papás): `fotos/` con clasificación automática  (`14_classify_photos.py`)
**La forma fácil, sin ordenar nada:** los papás sueltan TODAS las fotos en
`Cantares/fotos/` (raíz). Cada semana el sistema las clasifica solo en
`plantas/<especie>/`, `arboles/<especie>/`, `flores/<especie>/`, `aves/`, `paisaje/`,
`infraestructura/`, `visitantes/`, etc., y anota el **punto** por GPS. Motor:
**Pl@ntNet** (flora) con guardia de inventario. Principio: **antes sin clasificar que
mal clasificado** — lo dudoso queda en la carpeta general o `_sin_clasificar/` para
revisión manual. Borra duplicados por hash. Detalle y fases (Vision, iNaturalist):
[`PLAN_FOTOS_CLASIFICACION.md`](PLAN_FOTOS_CLASIFICACION.md). Reemplaza, para los
papás, el ordenado manual por id de abajo (que queda como curaduría fina del admin).

### 1.1 Entrada alternativa (curaduría fina del admin): `incoming/<id>/`  (`10_process_photos.py`)
Sueltas fotos en una subcarpeta nombrada como el **id** de a qué pertenece:

```
inputs/photos/incoming/
  especies/<species_id>/     ids en app/public/data/species.json
  puntos/<waypoint_id>/       ids en waypoints.geojson  (punto_1 … punto_16)
  senderos/<trail_id>/        ids en trails.geojson     (sendero_1 … sendero_12)
  recorridos/<route_id>/      ids en routes.json        (agua, aves, arboles, flora,
                                                         paisaje, regeneracion, nocturno)
  _sin_clasificar/            si no sabes el id
```
El script optimiza (WebP+JPG+miniatura), lee fecha/GPS EXIF, oscurece coordenadas
de especies sensibles, respalda el original y actualiza **`media.json`**. La app
muestra las fotos (especies y puntos ya; senderos/recorridos quedan almacenados,
ver «Pendiente»). Detalle: [`MEDIA_SYSTEM.md`](MEDIA_SYSTEM.md).

### 1.2 Vuelta: juego → sistema  (`13_ingest_game_photos.py`)
Las fotos que el visitante toma en el juego viven en su navegador. El admin las
respalda con **«Exportar fotos de campo»** en la app (módulo `js/field-export.js`),
que descarga un `cantares_campo_AAAA-MM-DD.json` con los avistamientos + fotos
(base64). Lo dejas en `inputs/photos/field/_incoming/` y el script:
- guarda cada foto en `inputs/photos/field/<species_id | _sin_identificar>/`,
- acumula los avistamientos en `info/censos_inventarios/avistamientos_juego.csv`
  (Darwin Core simplificado, deduplicado),
- así el **inventario ciudadano del juego se integra** con el resto.

---

## 2. Documentos — categorizar y encontrar  (`12_build_doc_catalog.py`)

Hub central en **`info/`** con carpetas por categoría. Dos funciones:
- **Auto-archiva**: lo que dejes en `info/_inbox/` se mueve solo a su categoría
  (por palabras clave del nombre).
- **Indexa**: escanea todos los documentos (en `info/` + los PDFs de `inputs/`),
  extrae un resumen de texto con **markitdown**, y genera:
  - **`info/INDEX.md`** — catálogo navegable por un humano (buscable con Ctrl+F).
  - **`info/catalog.json`** — índice para máquina / búsqueda.

Categorías: `censos_inventarios`, `ambiental`, `normativo`, `cartografia`,
`interpretacion`, `administrativo`, `otros`. Se afinan editando la lista de
palabras clave en el script (`CATEGORIES`). No mueve archivos abiertos (lock
`~$…`) ni los PDFs de `inputs/` (los usan otros scripts): esos se indexan en sitio.

---

## 3. Automatización periódica

`run_sic.py` corre en orden: **clasificar fotos** (`14`) → fotos admin→app (`10`) →
fotos del juego (`13`) → catálogo de documentos (`12`). La tarea **`CantaresSIC`**
(Programador de Tareas de Windows) lo ejecuta **cada semana (domingo 12:00)**.
El flujo es bajo; no necesita más. **Necesita el PC encendido**: si estaba apagado a
esa hora, corre **en cuanto lo prendas e inicies sesión** (opción `StartWhenAvailable`).

```
Registrar (semanal):   powershell -ExecutionPolicy Bypass -File data_prep/setup_scheduler.ps1
Quincenal:             powershell -File data_prep/setup_scheduler.ps1 -Every biweekly
Correr ahora (prueba): schtasks /Run /TN CantaresSIC
Ver estado:            schtasks /Query /TN CantaresSIC
Quitar:                powershell -File data_prep/setup_scheduler.ps1 -Remove
```

> El catálogo de documentos **cachea las vistas previas** (por fecha de
> modificación): solo re-lee con markitdown los archivos que cambiaron, así la
> corrida semanal es rápida aunque haya PDFs grandes.

---

## 4. Uso diario (sin programar)

1. **Fotos (papás)** → soltar TODO, sin ordenar, en `Cantares/fotos/`. El sistema
   las clasifica solo (o `inputs/photos/incoming/<tipo>/<id>/` para curaduría fina).
2. **Documentos nuevos** → soltar en `info/_inbox/`.
3. **Respaldar fotos del juego** → botón «Exportar fotos de campo» en la app →
   dejar el `.json` en `inputs/photos/field/_incoming/`.
4. No hacer nada más: cada 4 h el sistema procesa, archiva e indexa. (O correr
   `python inmersive_app/data_prep/run_sic.py` para verlo al instante.)
5. Para encontrar un documento: abrir `info/INDEX.md` y Ctrl+F.

---

## 5. Qué se versiona (git) y qué no

- **Sí** al repo: los scripts, `media.json`, las imágenes web optimizadas
  (`app/public/img/`), y el **catálogo** (`info/INDEX.md`, `info/catalog.json`).
- **No** al repo (viven en Dropbox, pesados): los **documentos fuente** de `info/`
  (PDF/DOCX/XLSX), los **originales** de fotos, y las **fotos de campo** del juego.
  Dropbox los respalda. Ver `.gitignore`.

---

## 6. Pendiente / coordinación

- **Mostrar fotos de senderos/recorridos en la app**: el pipeline ya las almacena
  en `media.json` (`subject_type` = `trail`/`route`), pero falta engancharlas en la
  UI (panel de ruta). Es un cambio de front-end → **coordinar con la sesión de
  admin** para no chocar.
- **Botón «Exportar fotos de campo»**: el módulo `js/field-export.js` está listo y
  se autoexpone como `window.exportFieldBackup`; falta una línea que lo enganche a
  un botón (en el panel admin o en «Mis registros»). También coordinable con admin.
- **Cuando exista el backend (Supabase)**: el flujo de vuelta puede volverse
  automático (la app sube las fotos y un script las baja a Dropbox), sin el paso
  manual de exportar/soltar el JSON.
