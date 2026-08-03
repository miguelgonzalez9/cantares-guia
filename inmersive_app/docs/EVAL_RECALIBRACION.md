# Recalibración del clasificador

Generado por `24_eval_bulk.py rescore --write`: re-puntúa desde los ORIGINALES las mismas imágenes auditadas y aplica la configuración actual de `id_local.py`. Compara contra los veredictos humanos, así que mide el efecto real de un cambio de prompts o umbrales.

Base: **239** imágenes auditadas (221 correctas, 18 falsos positivos).


## Resultado

| | antes | después |
|---|---:|---:|
| falsos positivos publicados | 18 | 8 |
| aciertos publicados | 221 | 206 |
| precisión de lo publicado | 92% | **96%** |
| cobertura | 100% | **90%** |

Lo que sale de «publicado» no se pierde: cae en `_sin_clasificar` y se revisa a mano. Un error con confianza alta sí es una pérdida.


## Falsos positivos corregidos (10)

| # | etiqueta vieja | ahora | por qué |
|---:|---|---|---|
| 15 | `aguas` | `_sin_clasificar` | baja confianza (aguas 0.77 < 0.85) |
| 49 | `arbol` | `_sin_clasificar` | excluida del auto (madera) |
| 62 | `arbol` | `_sin_clasificar` | excluida del auto (madera) |
| 66 | `arbol` | `_sin_clasificar` | excluida del auto (madera) |
| 72 | `arbol` | `_sin_clasificar` | excluida del auto (madera) |
| 73 | `arbol` | `_sin_clasificar` | baja confianza (arbol 0.64 < 0.66) |
| 74 | `arbol` | `_sin_clasificar` | excluida del auto (madera) |
| 159 | `mamifero` | `_sin_clasificar` | baja confianza (mamifero 0.79 < 0.85) |
| 217 | `planta` | `_sin_clasificar` | baja confianza (planta 0.65 < 0.66) |
| 243 | `visitante` | `_sin_clasificar` | baja confianza (visitante 0.51 < 0.52) |

## Falsos positivos que siguen (8)

| # | etiqueta | era en realidad | confianza |
|---:|---|---|---|
| 65 | `arbol` | `planta` | arbol 0.75 (margen 0.68) |
| 189 | `paisaje` | `infraestructura` | paisaje 0.79 (margen 0.62) |
| 200 | `planta` | `paisaje` | planta 0.91 (margen 0.87) |
| 209 | `planta` | `paisaje` | planta 0.98 (margen 0.97) |
| 214 | `planta` | `flor` | planta 0.89 (margen 0.81) |
| 218 | `planta` | `flor` | planta 0.90 (margen 0.84) |
| 219 | `planta` | `flor` | planta 0.75 (margen 0.57) |
| 233 | `visitante` | `infraestructura` | visitante 0.57 (margen 0.38) |

## Aciertos perdidos a revisión manual (15)

Coste de la recalibración. Cada línea es una foto correcta que ahora hay que clasificar a mano.

| # | era | ahora | por qué |
|---:|---|---|---|
| 46 | `aracnido` | `_sin_clasificar` | baja confianza (aracnido 0.85 < 0.85) |
| 51 | `arbol` | `_sin_clasificar` | baja confianza (paisaje 0.62 < 0.76) |
| 78 | `ave` | `_sin_clasificar` | baja confianza (ave 0.91 < 0.92) |
| 103 | `ave` | `_sin_clasificar` | baja confianza (ave 0.92 < 0.92) |
| 147 | `insecto` | `_sin_clasificar` | baja confianza (insecto 0.81 < 0.82) |
| 148 | `insecto` | `_sin_clasificar` | excluida del auto (madera) |
| 178 | `paisaje` | `_sin_clasificar` | baja confianza (paisaje 0.72 < 0.76) |
| 205 | `planta` | `_sin_clasificar` | baja confianza (planta 0.63 < 0.66) |
| 228 | `visitante` | `_sin_clasificar` | baja confianza (visitante 0.48 < 0.52) |
| 239 | `visitante` | `_sin_clasificar` | excluida del auto (madera) |
| 242 | `visitante` | `_sin_clasificar` | baja confianza (visitante 0.47 < 0.52) |
| 248 | `visitante` | `_sin_clasificar` | excluida del auto (madera) |
| 253 | `visitante` | `_sin_clasificar` | excluida del auto (madera) |
| 254 | `visitante` | `_sin_clasificar` | excluida del auto (madera) |
| 255 | `visitante` | `_sin_clasificar` | baja confianza (visitante 0.40 < 0.52) |
