# Precisión del clasificador sobre el volumen real

Catálogo: **3936** entradas · **2232** etiquetadas (56.7%) · **1704** sin clasificar (abstención 43.3%).

Muestra auditada: **239** de 257 (semilla 20260803, hasta 30 por categoría).

La abstención NO es un error: es el diseño. Lo que se mide aquí es la precisión de lo que el modelo **sí** se atrevió a etiquetar.


## Precisión por categoría

| categoría | auditadas | correctas | precisión | IC 95% (Wilson) | en el catálogo |
|---|---:|---:|---:|---|---:|
| `arbol` | 25 | 18 | 72% | 52% – 86% | 36 |
| `planta` | 24 | 18 | 75% | 55% – 88% | 274 |
| `mamifero` | 5 | 4 | 80% | 38% – 96% | 5 |
| `visitante` | 30 | 28 | 93% | 79% – 98% | 223 |
| `aguas` | 28 | 27 | 96% | 82% – 99% | 43 |
| `paisaje` | 30 | 29 | 97% | 83% – 99% | 1148 |
| `ave` | 30 | 30 | 100% | 89% – 100% | 389 |
| `flor` | 25 | 25 | 100% | 87% – 100% | 72 |
| `insecto` | 15 | 15 | 100% | 80% – 100% | 15 |
| `anfibio` | 10 | 10 | 100% | 72% – 100% | 10 |
| `aracnido` | 7 | 7 | 100% | 65% – 100% | 7 |
| `reptil` | 6 | 6 | 100% | 61% – 100% | 6 |
| `hongo` | 4 | 4 | 100% | 51% – 100% | 4 |
| **global** | **239** | **221** | **92%** | **88% – 95%** | **2232** |

Ordenado de peor a mejor. Una categoría con pocas auditadas tiene un intervalo ancho: no se puede concluir nada de ella todavía.


## Confianza: aciertos vs errores

Si los errores viven a confianza baja, subir el umbral los mata barato. Si viven a confianza alta, el umbral no es la herramienta.

| categoría | confianza media acierto | confianza media error | peor error |
|---|---:|---:|---:|
| `arbol` | 0.77 | 0.75 | 0.87 |
| `planta` | 0.85 | 0.85 | 0.98 |
| `mamifero` | 0.98 | 0.86 | 0.86 |
| `visitante` | 0.78 | 0.70 | 0.72 |
| `aguas` | 0.92 | 0.96 | 0.96 |
| `paisaje` | 0.94 | 0.94 | 0.94 |
| `ave` | 0.98 | — | — |
| `flor` | 0.85 | — | — |
| `insecto` | 0.94 | — | — |
| `anfibio` | 0.98 | — | — |
| `aracnido` | 0.97 | — | — |
| `reptil` | 0.92 | — | — |
| `hongo` | 0.99 | — | — |

## Umbral que atajaría cada falso positivo

| categoría | umbral necesario | aciertos perdidos | veredicto |
|---|---:|---:|---|
| `arbol` | 0.88 | 15/18 | **el umbral no sirve** — el error tiene tanta confianza como el acierto |
| `planta` | 0.99 | 16/18 | **el umbral no sirve** — el error tiene tanta confianza como el acierto |
| `mamifero` | 0.87 | 0/4 | subir el umbral es viable |
| `visitante` | 0.73 | 12/28 | caro: cuesta 43% de la cobertura |
| `aguas` | 0.97 | 26/27 | **el umbral no sirve** — el error tiene tanta confianza como el acierto |
| `paisaje` | 0.95 | 13/29 | caro: cuesta 45% de la cobertura |
| `ave` | — | — | sin falsos positivos en la muestra |
| `flor` | — | — | sin falsos positivos en la muestra |
| `insecto` | — | — | sin falsos positivos en la muestra |
| `anfibio` | — | — | sin falsos positivos en la muestra |
| `aracnido` | — | — | sin falsos positivos en la muestra |
| `reptil` | — | — | sin falsos positivos en la muestra |
| `hongo` | — | — | sin falsos positivos en la muestra |

Perder cobertura no es gratis pero tampoco es un error: lo que se pierde cae en `_sin_clasificar` y se revisa a mano. Lo que no se puede aceptar es un error con confianza alta.


## Con qué se confunde

| predijo | era en realidad | veces |
|---|---|---:|
| `aguas` | `reptil` | 1 |
| `arbol` | `infraestructura` | 5 |
| `arbol` | `planta` | 1 |
| `arbol` | `visitante` | 1 |
| `mamifero` | `_sin_clasificar` | 1 |
| `paisaje` | `infraestructura` | 1 |
| `planta` | `flor` | 3 |
| `planta` | `paisaje` | 2 |
| `planta` | `_sin_clasificar` | 1 |
| `visitante` | `infraestructura` | 2 |

Una categoría que absorbe sistemáticamente otra suele significar que a la lista de etiquetas le falta una clase, no que el umbral esté mal.

