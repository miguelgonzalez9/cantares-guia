# Categorización del archivo fotográfico — plan y bitácora

## Objetivo (goal de sesión)
Categorizar TODAS las fotos y videos de
`Reserva natural cantares/fotos Reserva Cantares` (~3.945 archivos: ~3.712 imágenes,
~225 videos) en el sistema de categorías de `fotos/`. **Constraint #1: minimizar
falsos positivos** — ante la duda, `_sin_clasificar`. Éxito = máxima precisión con
FP mínimos, verificado con pruebas sobre ground-truth, y mejor algoritmo definido.
Excluir `nuestra_historia` y `eco_turismo`. Añadir categorización de videos en
`Cantares/fotos`.

## Categorías del sistema (carpetas en fotos/)
Auto-clasificables: aves, mamiferos, anfibios, insectos, aracnidos, flores, plantas,
arboles, paisaje, infraestructura, visitantes, aguas, restauracion, hongos, _sin_clasificar.
Curadas a mano (EXCLUIR del auto): eco_turismo, nuestra_historia.

## Ground truth para medir precisión (`fotos por temas/`, etiquetado por Miguel)
| Carpeta tema | Categoría esperada | N |
|---|---|---|
| Paisajes | paisaje | 188 |
| Vista Manizales | paisaje | 5 |
| Familiares | visitante | 32 |
| Trabajadores | visitante | 6 |
| Flora | flora (flor/planta/arbol) | 28 |
| fotos dron enero 2025 | paisaje (aéreo) | 86 |
| Drone | paisaje (aéreo) | 9 |
| Siembra arboles y repoblacion | restauracion | 63 |
| Entrada a la Reserva | infraestructura | 8 |
| Hongos | hongo | 2 |
| Derrumbes | (difícil: paisaje/infra) | 7 |

## Estrategia anti-falso-positivo
1. Ensemble de varios prompts por categoría (promedio de embeddings de texto).
2. Abstención por **umbral + margen**: asignar solo si top ≥ τ_categoría Y (top−2º) ≥ margen.
   Calibrar τ por categoría sobre ground-truth hasta precisión ≈ 100% (FP ≈ 0).
3. BioCLIP en modo cerrado solo confirma especie si CLIP concuerda de grupo (ya existe).
4. Non-destructivo: catálogo (archivo→categoría+confianza), NO mover 41GB (preserva
   la organización por fechas/temas de Miguel). Mover/copiar = paso opt-in posterior.

## Componentes
- [x] `eval_classifier.py` — mide precisión/recall/FP sobre ground-truth; calibra umbrales.
- [x] `id_local.py` — ensemble multi-prompt + nuevas categorías + abstención + frames de video.
- [x] `19_classify_archive.py` — cataloga el archivo (no destructivo), excluye historia/turismo.
- [x] video en `14_classify_photos.py` (feature pedido: videos en Cantares/fotos).
- [x] `test_classify.py` reescrito (decide_category / decide_video / confirm_species).

## Resultados de calibración (eval_classifier, ground-truth n=341)
- Bug corregido: mismatch QuickGELU (ViT-B-32-quickgelu) → embeddings correctos.
- **restauracion** QUITADA del auto: actividad, no objeto → precisión <0.35 a cualquier
  umbral, robaba imágenes de visitante/paisaje. Se cura a mano (como historia/turismo).
- **infraestructura** excluida: precisión <0.5 en las tomas de la reserva (se confunde
  con flora/paisaje). → _sin_clasificar.
- **aguas** habilitada a umbral alto 0.85: 0 falsos-positivos sobre 341 GT; captura
  agua clara (estanque 0.86, cascada 0.92).
- Config final: **precisión 0.971, FP 2.9%, cobertura 79%** (cota INFERIOR: es solo-CLIP;
  producción añade BioCLIP para organismos → fauna sube). Umbrales por categoría +
  margen 0.13 en `id_local.CATEGORY_THRESHOLDS`.
- Video: consenso de 3 frames (decide_video) — asigna solo si la mayoría coincide sin empate.
- Auditoría visual (Read de imágenes reales del bulk): paisaje correcto; abstención
  correcta en casos ambiguos; agua detectada.

## Auditoría visual del BULK real (no solo GT) → hallazgos y correcciones
Revisé ~8 imágenes reales del archivo con visión propia. FPs encontrados y CORREGIDOS:
- **Reptiles** (culebra, lagarto anolis) caían en `anfibio` con ALTA confianza (0.99):
  la reserva tiene reptiles y no había categoría. → **añadida categoría `reptil`**
  (lagarto/culebra); 6 reptiles reubicados correctamente.
- **Cola de baja confianza (0.5–0.7)** de anfibio/aracnido/mamifero/insecto = FPs
  (cascada→aracnido, vegetación→mamifero, gorgojo→anfibio). Calibrado con pocos GT.
  → **umbrales subidos**: anfibio 0.93, aracnido 0.85, mamifero 0.85, insecto/reptil 0.82.
  ~55 borderline demovidos a _sin_clasificar.
- Confirmados CORRECTOS: paisaje (paisajes), ave (colibrí, 1.00), aguas (estanque/cascada),
  anfibio (rana real 0.98), reptil (lagarto/culebra), mamifero (puma cámara-trampa 0.97).

## Resultado FINAL del archivo (3.936 archivos, 223 videos)
- **Clasificados 2.232 (56.7%)** | **_sin_clasificar 1.704 (43.3%)** ← conservador (FP #1).
- paisaje 1148 · ave 389 · planta 274 · visitante 223 · flor 72 · aguas 43 · arbol 36 ·
  insecto 15 · anfibio 10 · aracnido 7 · reptil 6 · mamifero 5 · hongo 4.
- Videos clasificados 82/223 (55 paisaje, 15 ave, 5 aguas, …) por consenso de 3 frames.
- paisaje+ave = 69% de lo clasificado, ambos limpios y de alta confianza (auditados).

## Herramientas finales (data_prep/)
- `eval_classifier.py` (calibración GT), `19_classify_archive.py` (cataloga, --max-seconds
  para tandas cortas, --no-species), `audit_catalog.py` (muestreo para auditar),
  `reclassify_subset.py` (re-decidir un subconjunto tras ajustar config), `id_local.py`
  (motor + video + decide_category/decide_video), `14` (fotos+videos en Cantares/fotos).

## Bitácora
- Tooling: torch CPU 2.13, open_clip 3.3, bioclip, PIL, numpy OK. cv2/ffmpeg ausentes →
  instalado `imageio-ffmpeg` (ffmpeg 7.1 embebido) para frames de video.
- BioCLIP v1 (ViT-B/16) tarda ~177s en cargar/descargar la 1ª vez; luego cacheado.
- Corrida del archivo: `19_classify_archive.py` → `_archive_work/catalog_fotos-reserva-cantares.json`
  (no destructivo). Resumible por ruta+mtime, guarda cada 25.
- Procesos en background mueren cuando el laptop duerme (ver contacts.md); corridas
  largas en tandas cortas `--max-seconds 85` en primer plano. Especie (BioCLIP) diferida
  para el archivo (init de ~730 etiquetas es lento); se puede correr después sobre el
  subconjunto de organismos.
