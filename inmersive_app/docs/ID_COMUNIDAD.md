# Identificación por comunidad — qué es viable y qué no

Investigado 2026-08-03 para el issue #2. La pregunta era: el clasificador local
se abstiene en el 43% del archivo — ¿puede una API de comunidad cerrar parte de
esa brecha?

Respuesta corta: **sí para plantas, no para fauna**, y por una razón que no es
técnica.

## Las tres opciones

| | Pl@ntNet | iNaturalist (visión) | GBIF |
|---|---|---|---|
| ¿Hay API pública? | **sí** | **no** | sí |
| Cuota gratis | 500 identificaciones/día | — | sin límite práctico |
| Clave | sí (gratis, my.plantnet.org) | JWT, sólo apps propias y socios | ninguna |
| Cubre | sólo plantas | todo (si tuvieras acceso) | ningún taxón por imagen |
| Devuelve | especie + score 0–1 | — | resolución de nombres |
| Video | no | — | no |
| Licencia de uso | «uso limitado y sin ánimo de lucro» | — | CC0 |

### Pl@ntNet — viable, con una salvedad de licencia

500 identificaciones diarias gratis alcanzan de sobra: la cola de flora sin
clasificar del archivo se procesa en unos pocos días de lotes, y el uso en vivo
desde la app es de una foto por visitante.

**La salvedad:** los términos son «uso limitado y sin ánimo de lucro». Cantares
tiene una parte comercial (Airbnb, pasadías, tarifas). Identificar plantas para
el inventario propio y para una app gratuita de visitantes es defendible; si la
identificación pasara a ser parte de un servicio que se cobra, hay que pasar al
plan Pro (factura inicial de €1.000). **Decisión pendiente de Miguel**, no mía.
Mientras tanto el uso es claramente del lado sin ánimo de lucro.

### iNaturalist — la API de visión NO está disponible

Esto invalida el supuesto del plan original. El endpoint que usan sus propias
apps (`/v1/computervision/score_image`) exige un JWT y no está abierto a
terceros; los modelos completos son privados por propiedad intelectual y porque
muchas fotos de la plataforma son «todos los derechos reservados». Sólo publican
modelos «pequeños» de ~500 taxones, que no incluyen la fauna de la reserva.

Lo que **sí** existe es lo que Miguel realmente pidió, aunque funcione distinto:
**publicar observaciones y recoger las identificaciones que la comunidad haga**.
No es una llamada síncrona sino un ciclo de días o semanas, con humanos reales
identificando. Para fauna (aves, anfibios, insectos) es más fiable que cualquier
modelo, y la app ya enlaza el proyecto de la reserva (`CONFIG.inatProjectUrl`).

Eso es una funcionalidad aparte, no un sustituto del clasificador: se propone
como issue futuro, no entra aquí.

### GBIF — útil, pero para otra cosa

No identifica imágenes. Sirve para normalizar nombres científicos y detectar
sinónimos, que es un problema real del inventario (el censo 2021 y eBird no
siempre usan el mismo nombre). Gratis, sin clave. Fuera del alcance de este issue.

## Lo que se construye, entonces

Sólo el camino Pl@ntNet, y detrás de un proxy.

**Por qué un proxy y no una llamada directa.** `game.js` ya tenía una llamada a
Pl@ntNet desde el navegador con `plantnetApiKey` en el código. Estaba vacía, así
que nunca filtró nada — pero rellenarla habría publicado la clave en un repo
público servido por GitHub Pages, y con ella cualquiera puede agotar la cuota
diaria. La clave vive en el servidor o no vive.

```
navegador / script local
        │  imagen
        ▼
inmersive_app/supabase/functions/identify   ← PLANTNET_API_KEY (secreto)
        │  Pl@ntNet
        ▼
  re-ranking contra species.json   ← una especie fuera del inventario NO se acepta
  umbral + margen                  ← mismo criterio que id_local
        ▼
  candidatos  ·  o  abstain
```

El re-ranking contra el inventario es la misma guardia de conjunto cerrado que
usa BioCLIP en local: Pl@ntNet conoce ~50.000 especies del mundo y la reserva
tiene ~700. Una propuesta que no esté en el inventario no se asigna — pero
tampoco se descarta en silencio: se devuelve marcada como posible hallazgo
nuevo, que es información valiosa para el inventario.

## Riesgos

- **La cuota es diaria y compartida** entre la app y los lotes locales. Si un
  día de mucha visita agota las 500, el proxy debe degradar al identificador
  manual asistido, no fallar.
- **Pl@ntNet rechaza lo que no es planta con score bajo**, lo que lo hace un buen
  filtro de primera pasada — pero un score bajo también puede ser una planta mal
  fotografiada. No confundir «no es planta» con «no sé».
- **Antes sin clasificar que mal clasificado** sigue mandando: si el margen sobre
  el segundo candidato es pequeño, se devuelve `abstain` aunque el score sea alto.

## Fuentes

- [Pl@ntNet: términos y condiciones](https://my.plantnet.org/terms_of_use)
- [Pl@ntNet: precios y condiciones](https://my.plantnet.org/pricing)
- [Pl@ntNet: referencia de la API](https://docs.plantnet.org/en/reference/api-plantnet/)
- [iNaturalist: desarrolladores](https://www.inaturalist.org/pages/developers)
- [iNaturalist forum: «Hidden» Computer Vision API](https://forum.inaturalist.org/t/hidden-computer-vision-api/41775)
- [inatVisionAPI (modelos «pequeños» públicos)](https://github.com/inaturalist/inatVisionAPI)
