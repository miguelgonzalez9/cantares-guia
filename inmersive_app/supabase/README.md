# Supabase — Edge Functions

Funciones que corren en el servidor de Supabase. Existen para una sola razón:
**guardar claves que no pueden estar en el navegador**. Este repo es público y se
sirve por GitHub Pages, así que cualquier clave en `app/public/js/` queda
publicada.

| función | qué hace | secreto |
|---|---|---|
| `identify` | identifica plantas con Pl@ntNet y re-rankea contra el inventario de la reserva | `PLANTNET_API_KEY` |

## OJO con el directorio de trabajo

La CLI busca `supabase/functions/<nombre>` **relativo a donde la corres**. Esta
carpeta vive dentro de `inmersive_app/`, así que hay que estar ahí:

```
cd C:\Users\migol\Dropbox\Cantares\inmersive_app
```

Desde la raíz del repo la CLI no encuentra la función y falla con «Function not
found». (Se movió aquí el 2026-08-04 para que todo lo de la app viva bajo
`inmersive_app/`.)

## Desplegar

En Windows usa **`npx.cmd`**, no `npx`: la política de ejecución de PowerShell
bloquea `npx.ps1` y da un `UnauthorizedAccess` que no tiene nada que ver con
Supabase.

```
npx.cmd supabase login
npx.cmd supabase secrets set PLANTNET_API_KEY=... --project-ref rmfwrzteuraatdutwaqj
npx.cmd supabase functions deploy identify --project-ref rmfwrzteuraatdutwaqj
```

No hace falta instalar nada ni tener Docker: Docker sólo se necesita para correr
Supabase en local, no para desplegar. El secreto se pone **una vez** por proyecto,
no en cada despliegue.

## Comprobar que quedó viva

```
curl -X POST "https://rmfwrzteuraatdutwaqj.supabase.co/functions/v1/identify" \
  -H "Authorization: Bearer <anon key de app/public/js/cloud.js>"
```

| respuesta | significa |
|---|---|
| `400` «se esperaba multipart/form-data con `image`» | ✅ viva y con la clave puesta |
| `503` «PLANTNET_API_KEY sin configurar» | falta el `secrets set` |
| `404` | falta el `functions deploy` (o lo corriste desde la carpeta equivocada) |

## Probar la lógica sin red ni clave

```
node inmersive_app/supabase/functions/identify/identify.test.mjs
```

Cubre la guardia de conjunto cerrado (nada fuera del inventario se asigna), el
umbral, el margen medido contra el segundo *del inventario*, y que un candidato
de fuera con score ínfimo sea abstención y no un «hallazgo». También comprueba
que los umbrales de la copia de prueba no se hayan separado de `index.ts`.
