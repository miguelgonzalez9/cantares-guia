# 📸 Cómo agregar fotos a la app (sin programar)

La app muestra una foto por cada **especie** y cada **punto clave**. Para
agregarlas, solo tienes que **soltar tus fotos en la carpeta correcta** y avisar
para correr el script. El sistema hace el resto: las achica, las optimiza,
guarda el original de respaldo y actualiza el catálogo.

## Paso 1 — Suelta las fotos en su carpeta

La **carpeta = a qué pertenece la foto**. No tienes que renombrar nada.

```
incoming/
  especies/
    roble/        ← todas las fotos del Roble van aquí
      cualquier_nombre.jpg
      otra.jpg
    yarumo/       ← fotos del Yarumo
    barranquero/  ← fotos del Barranquero (ave)
  puntos/
    portada/      ← fotos del punto "Entrada / Portada"
    cascada_alta/
  _sin_clasificar/  ← si no sabes a qué especie es, déjala aquí (se revisa aparte)
```

- El nombre de la subcarpeta debe ser el **id** de la especie o del punto.
  Los ids están en `app/public/data/species.json` (campo `"id"`) y en
  `app/public/data/waypoints.geojson`. Si dudas, pon la foto en
  `_sin_clasificar/` y la clasificamos juntos.
- Puedes poner **varias fotos** por especie/punto. La primera se usa como
  imagen principal (luego se puede cambiar).
- Formatos: **JPG o PNG**. Si tu iPhone guarda en HEIC, cambia en
  *Ajustes → Cámara → Formatos → «Más compatible»* antes de tomarlas, o pásalas
  a JPG. (El script avisa si encuentra HEIC.)

## Paso 2 — Avísame para procesarlas

Corro `data_prep/10_process_photos.py`. Eso:
- Achica cada foto a tamaño web (rápida en el celular, se ve nítida).
- Crea versión moderna (WebP) + respaldo (JPG) + miniatura.
- Lee la **fecha y el GPS** de la foto (si los tiene) y avisa si una foto de
  especie fue tomada **fuera** de la reserva (posible error de clasificación).
- Guarda el original completo en `inputs/photos/_originals/` (respaldo, no se sube).
- Actualiza `app/public/data/media.json` (el catálogo de imágenes).

## Paso 3 — Publicar

Al hacer *commit* y *push*, la app en GitHub Pages muestra las fotos nuevas.

---

**Detalles técnicos:** ver `inmersive_app/docs/MEDIA_SYSTEM.md`.
