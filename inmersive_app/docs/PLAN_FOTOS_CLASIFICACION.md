# Diseño — Fotos: clasificación jerárquica + integración Pl@ntNet / iNaturalist

## Principio rector (lo más importante)

**Antes dejar sin clasificar que clasificar mal.** Cada decisión (categoría,
especie, punto) solo se toma con **alta confianza**; si no, la foto se queda en el
nivel más alto que sí se pudo, para revisión manual. Cero falsos positivos > cobertura.

## Los dos sistemas (mismo motor de IA)

| | **A — App/juego (web)** | **B — Archivo de los papás (local)** |
|---|---|---|
| Entrada | visitante toma foto en la app | papás sueltan fotos en `Cantares/fotos/` |
| Cuándo | en vivo, 1 foto | por lotes, **semanal** (tarea `CantaresSIC`) |
| Clave IA | detrás del proxy Supabase (servidor) | `.env` local (el script corre en el PC) |
| Humano | el visitante confirma «¿es esta?» | los papás revisan las carpetas de categoría |

Ambos llaman a la **misma lógica de identificación** (`idengine`): Pl@ntNet para
plantas, iNaturalist para fauna, con **re-ranking contra el inventario de la reserva**
y umbral conservador. Un solo cerebro, dos entradas.

## Decisiones (resueltas)

- `fotos/` a **nivel raíz** (`Cantares/fotos/`).
- Separar **árbol / planta / flor** (por hábito de la especie).
- **Reemplaza** el flujo `incoming/<id>/` para los papás.
- Alimenta el **stock de fotos de la app** (por especie y por punto).
- Automatización **semanal** (ya aplicado; `-Every biweekly` = quincenal).

## Jerarquía de salida (la CARPETA = la categoría; el punto NO es carpeta)

Cada foto vive en **una sola carpeta**, la de su categoría. El **punto es un
atributo** de la foto (metadato), no una carpeta paralela — así se evita la
intersección categoría×punto.

```
fotos/                          <- los papás sueltan aquí, sin ordenar
  plantas/<especie>/   arboles/<especie>/   flores/<especie>/
  aves/<especie>/   mamiferos/<especie>/   anfibios/<especie>/   insectos/<especie>/
  aves/  plantas/  ...           <- categoría segura pero especie incierta (revisión)
  paisaje/   infraestructura/   visitantes/   <- sin subnivel de especie
  _sin_clasificar/               <- ni la categoría fue segura (revisión total)
```

**El punto como atributo (no carpeta):** cada foto obtiene, además de su categoría,
un campo `punto` = `<punto_id>` o `null`. Se deriva **exclusivamente de los waypoints
de la app** (`waypoints.geojson` = *ground truth*): si el GPS EXIF de la foto cae a
≤ radio estricto de un waypoint, ese es su punto; si no, `null`. Se guarda en
`fotos/catalog_fotos.json`, no mueve el archivo. Una misma foto puede ser
`plantas/roble/…` **y** tener `punto: punto_5` — sin duplicarse.

## Flujo del Sistema B (local, `14_classify_photos.py`)

Por cada foto nueva en `fotos/` (raíz):

```
0. DEDUP: hash del contenido. ¿ya existe esa foto (mismo hash) en el sistema?
     SÍ → borrar la duplicada (no reprocesar).
1. EXIF: fecha + GPS.
2. Pl@ntNet: ¿planta con score alto Y la especie ESTÁ en el inventario?
     SÍ  → plantas|arboles|flores / <especie>/     (hábito decide árbol/planta/flor)
     NO  ↓   (Pl@ntNet rechaza lo no-planta con score bajo)
3. Vision (F2): ¿categoría gruesa con confianza alta?
     ave|mamífero|anfibio|insecto → (iNaturalist si hay acceso; si no) carpeta de
                                     la categoría → revisión manual
     persona → visitantes/ ;  edificación → infraestructura/ ;  vista → paisaje/
     NO  ↓
4. _sin_clasificar/            (nada seguro → revisión manual total)

ATRIBUTO PUNTO (siempre, LOCAL y determinista — NO mueve el archivo):
   ¿hay GPS EXIF y está a ≤ radio estricto (p.ej. 20 m) de un waypoint de la app?
     SÍ → campo  punto = <punto_id>    NO → punto = null
```

**Guardias anti-falso-positivo (el corazón del diseño):**
- **Especie** solo si: `score ≥ T_alto` **Y** margen sobre el 2º candidato **Y**
  la especie **está en el inventario** (`species.json`). Si Pl@ntNet propone algo
  que no está en la reserva → NO se asigna especie (queda en la categoría; posible
  hallazgo nuevo para revisión).
- **Categoría** solo si la etiqueta de Vision supera un umbral alto; si no → `_sin_clasificar/`.
- **Punto** (atributo) solo con GPS presente, precisión buena y radio estricto; si no, `null`.
- **Duplicados**: se detectan por hash del contenido y se **borran** (no se
  reprocesan ni se acumulan).
- Renombra la foto con fecha y registra todo (categoría, especie, confianza, GPS,
  punto, hash) en `fotos/catalog_fotos.json`.

## Alimentar la app (el «stock»)

- Fotos con **especie** confirmada → se promueven al sistema de la app
  (`media.json` + `app/public/img/`) reutilizando `10_process_photos.py` → aparecen
  en las fichas de especie.
- Fotos cuyo atributo **`punto`** ≠ null → `media.json` como foto de ese waypoint →
  aparecen en la ficha del punto (el punto viene de los waypoints de la app, que son
  el *ground truth*).
- Fotos que quedaron en **categoría general** (sin especie/punto) → son el stock que
  los papás **clasifican a mano desde la app** (bandeja de revisión en el admin).

## Sistema A (app/juego) — misma integración

El juego ya tiene el flujo foto→ID→inventario (ver [`AI_ENGINE_PLAN.md`](AI_ENGINE_PLAN.md)):
mismo `idengine`, pero online, detrás del **proxy Supabase** (clave protegida), una
foto a la vez, con el paso humano «¿es esta?». Es el mismo cerebro que el Sistema B,
solo cambia el envoltorio (web vs. local). Construir `idengine` una vez sirve a ambos.

## Fases

- **F1 — flora + puntos (barato, alta precisión, cero falso positivo):**
  Pl@ntNet (plantas/árboles/flores) con guardia de inventario + **GPS→puntos (local)**
  + degradación + índice. Lo no-planta va a `_sin_clasificar/` hasta F2. Cubre ~60%
  del inventario y no requiere Google Cloud.
- **F2 — fauna y categorías no-planta:** Google Vision para categoría gruesa;
  iNaturalist para especie de fauna (si se obtiene acceso).
- **F3 — promoción automática a la app + modelo propio + unificar con el proxy web
  (Sistema A):** entrenar un clasificador pequeño con las fotos ya organizadas
  (conjunto cerrado de la reserva) → clasifica offline, sin gastar API.

## Insumos / decisiones pendientes para arrancar F1

1. **Clave Pl@ntNet** (gratis, my.plantnet.org) → va en `data_prep/.env`
   (local, gitignored; plantilla `.env.example` ya lista). Es lo único que bloquea F1.
2. Umbrales (propongo, ajustables): especie `score ≥ 0.40` **y** en inventario;
   punto `≤ 20 m`; margen 2º candidato `≥ 0.10`. Conservador a propósito.
3. (F2) cuenta Google Cloud (Vision, ~$1–2/mes con tope).
4. (F2/F3) acceso a iNaturalist (correo de solicitud).

## Verificación (al implementar F1)

- Soltar en `fotos/` un lote mixto (varias plantas de inventario, un árbol, una
  orquídea, un ave, una foto del vivero, una de una persona, una borrosa) → correr
  `python inmersive_app/data_prep/14_classify_photos.py` → confirmar: plantas/árbol/
  flor a su `<especie>/`; el ave y la borrosa a `_sin_clasificar/` (no se inventan);
  las que tengan GPS de un punto quedan con `punto: <id>` en el catálogo (no en carpeta
  aparte); una foto **repetida** se borra por hash. Revisar `catalog_fotos.json`.
- Verificar que una planta que NO está en el inventario **no** se archiva como
  especie (queda en `plantas/` para revisión) — prueba clave del anti-falso-positivo.
- `grep` del repo: la clave Pl@ntNet **no** aparece (vive en `.env`).
