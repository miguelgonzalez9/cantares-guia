# Traer muestras del archivo desde Dropbox

La app puede **listar tu Dropbox y bajar sola** una muestra de fotos del archivo
para clasificarlas en la bandeja de Fotos, sin señalar la carpeta a mano.

Funciona porque la API de Dropbox habla **CORS**: el navegador puede llamarla
directamente, sin servidor ni script local. Hasta que hagas la puesta en marcha de
abajo, el botón de Dropbox no aparece y queda el respaldo — «📂 Elegir carpeta a
mano» — que hace exactamente lo mismo pidiéndote la carpeta.

---

## Puesta en marcha (una vez, ~2 minutos)

1. Entra a <https://www.dropbox.com/developers/apps> → **Create app**.
   - API: **Scoped access**
   - Tipo de acceso: **Full Dropbox** (el archivo está en `/Cantares/fotos`)
   - Nombre: `Cantares Guía` (o el que quieras)

2. En la pestaña **Permissions**, marca **sólo** estos dos y guarda:
   - `files.metadata.read`
   - `files.content.read`

   > Sólo lectura a propósito: la app **no puede** escribir ni borrar nada en tu
   > Dropbox aunque tuviera un fallo.

3. En **Settings → OAuth 2 → Redirect URIs**, añade exactamente:

   ```
   https://miguelgonzalez9.github.io/cantares-guia/
   ```

   (Si pruebas en local, añade también `http://localhost:8000/`.)

4. Copia la **App key** y pégala en `app/public/js/dropbox.js`:

   ```js
   const APP_KEY = 'tu_app_key_aqui';
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

## Si algo falla

| Qué ves | Qué pasa |
|---|---|
| No aparece el botón de Dropbox | `APP_KEY` está vacía (paso 4) |
| «Dropbox no está conectado» | Se borró el `localStorage`; vuelve a conectar |
| 400 al bajar una foto | Nombre con tildes mal escapado — lo cubre `headerSafeJSON`, avisa si reaparece |
| 401 / «invalid_grant» | Revocaste el acceso o caducó el refresh token; reconecta |
| No lista nada | Revisa que `ARCHIVE_ROOT` (en `dropbox.js`) sea la ruta **dentro** de Dropbox |
