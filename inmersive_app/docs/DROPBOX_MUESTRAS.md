# Traer muestras del archivo desde Dropbox

La app puede **listar tu Dropbox y bajar sola** una muestra de fotos del archivo
para clasificarlas en la bandeja de Fotos, sin señalar la carpeta a mano.

Funciona porque la API de Dropbox habla **CORS**: el navegador puede llamarla
directamente, sin servidor ni script local. Hasta que hagas la puesta en marcha de
abajo, el botón de Dropbox no aparece y queda el respaldo — «📂 Elegir carpeta a
mano» — que hace exactamente lo mismo pidiéndote la carpeta.

---

## Antes de nada: tu Dropbox tiene cosas privadas

Sí. `info/` guarda escrituras, contabilidad y exportaciones de WhatsApp, y el
resto de la cuenta es tuyo. **Elige el tipo de app con eso en mente**, porque es
la única frontera real — el código puede tener fallos, un permiso no.

| Tipo de app | Qué puede leer el token | Recomendación |
|---|---|---|
| **App folder** | **Sólo** `Apps/<nombre>/`. El resto de tu Dropbox no existe para él. | ✅ **Ésta** |
| Full Dropbox | Toda tu cuenta, incluido `info/`. | ⚠️ Sólo si no quieres mover las fotos |

Con **App folder** Dropbox crea `Apps/Cantares Guía/`; mueves o copias ahí la
carpeta `fotos` y pones `ARCHIVE_ROOT = ''` en `js/dropbox.js`. A partir de ese
momento, **aunque este código tuviera un fallo o alguien lo modificara, no puede
ver nada más**: no es que no lo intente, es que Dropbox no se lo permite.

Con **Full Dropbox** funciona sin mover nada, pero el token que queda en tu
navegador puede leer toda la cuenta. El código sólo pide `/Cantares/fotos` y hay
una guarda (`insideArchive`) que rechaza cualquier otra ruta — pero eso es
**defensa en profundidad, no una frontera**. Si tu Dropbox tiene material que no
quieres exponer ni a un fallo, usa App folder.

---

## Puesta en marcha (una vez, ~2 minutos)

1. Entra a <https://www.dropbox.com/developers/apps> → **Create app**.
   - API: **Scoped access**
   - Tipo de acceso: **App folder** (recomendado; ver arriba)
   - Nombre: `Cantares Guía` (o el que quieras)

2. En la pestaña **Permissions**, marca **sólo** estos dos y guarda:
   - `files.metadata.read`
   - `files.content.read`

   > Sólo lectura a propósito: la app **no puede** escribir ni borrar nada en tu
   > Dropbox aunque tuviera un fallo. No marques ningún `.write`.

3. En **Settings → OAuth 2 → Redirect URIs**, añade exactamente:

   ```
   https://miguelgonzalez9.github.io/cantares-guia/
   ```

   (Si pruebas en local, añade también `http://localhost:8000/`.)

4. Copia la **App key** y pégala en `app/public/js/dropbox.js`. Si elegiste
   **App folder**, ajusta también la raíz:

   ```js
   const APP_KEY = 'tu_app_key_aqui';
   export const ARCHIVE_ROOT = '';          // App folder: la raíz YA es tu carpeta
   // export const ARCHIVE_ROOT = '/Cantares/fotos';   // Full Dropbox
   ```

5. Sube el cambio y **sube la versión de `sw.js`**. En la app: Admin → Fotos →
   *Sin clasificar* → **🔗 Conectar Dropbox**, y autoriza. Vuelve sola.

---

## Por qué la App key va en el repositorio

Se usa **OAuth con PKCE**, el flujo diseñado para aplicaciones que no pueden
guardar un secreto — y ésta no puede: el repositorio es público y se sirve por
GitHub Pages. Con PKCE **no hay client secret**; la App key es un identificador
público, igual que la `anonKey` de Supabase.

Lo que de verdad autoriza es (a) tu consentimiento en la pantalla de Dropbox y
(b) el `code_verifier`, que se genera en tu dispositivo, no viaja nunca entero y
se borra al usarlo. El *refresh token* que queda vive en el `localStorage` de tu
navegador y sólo sirve para leer. Para cortar el acceso: <https://www.dropbox.com/account/connected_apps>.

**El client secret NO se pone aquí.** Si algún día hiciera falta uno, iría como
secreto de una Edge Function, jamás en el cliente.

---

## Cómo se elige la muestra

1. La app lista `/Cantares/fotos` **recursivo** — sólo metadatos, ni un byte de
   imagen.
2. Te enseña **cada carpeta con cuántas fotos tiene**, y eliges de cuáles y
   **cuántas de cada una** (por defecto 5 de cada; poner 0 la excluye).
3. Dentro de cada carpeta, la muestra se reparte por turnos entre especies y da
   prioridad a las que hoy **no tienen ninguna foto** en la app.
4. Se bajan **sólo las elegidas**, se comprimen en el teléfono/portátil y suben
   por la cola offline con tu sesión de admin.
5. Lo ya subido **se salta**, por hash sha256 del contenido — la misma identidad
   que usa `data_prep/26_sync_media.py`. Puedes repetir la tanda sin miedo.

Todo entra como `status: 'unclassified'`, `origin: 'local-archive'` y sin sujeto:
quien decide qué es cada foto es una persona, en la bandeja. Toca una miniatura
para verla grande antes de clasificarla.

---

## Lo que subes queda alcanzable públicamente

Esto es **independiente de Dropbox** y conviene tenerlo claro: la tabla `media` es
de **lectura pública** (`media_read ... using (true)`, migración 17) y los ficheros
viven en un bucket público de Supabase Storage. Una foto «sin clasificar» **no se
muestra** en ninguna galería —no tiene sujeto— pero **su URL existe y responde**.

Por eso:

- Las carpetas **sin revisar** (la raíz, y las que empiezan por `_` como
  `_sin_clasificar` o `_desde_app`) **no se marcan solas** y salen con ⚠︎. El
  archivo familiar tiene capturas de WhatsApp, gente y material de terceros.
- **Mira antes de traer.** Toca la miniatura para verla grande.
- Si algo no debía subir: **bórralo en la bandeja** y desaparece de la tabla y del
  bucket.

Si en algún momento quieres que ni siquiera sean alcanzables por URL mientras
esperan clasificación, eso es un cambio de backend: bucket privado + URLs firmadas
para el admin. Hoy no es así.

---

## Si algo falla

| Qué ves | Qué pasa |
|---|---|
| No aparece el botón de Dropbox | `APP_KEY` está vacía (paso 4) |
| «Dropbox no está conectado» | Se borró el `localStorage`; vuelve a conectar |
| 400 al bajar una foto | Nombre con tildes mal escapado — lo cubre `headerSafeJSON`, avisa si reaparece |
| 401 / «invalid_grant» | Revocaste el acceso o caducó el refresh token; reconecta |
| No lista nada | Revisa que `ARCHIVE_ROOT` (en `dropbox.js`) sea la ruta **dentro** de Dropbox |
