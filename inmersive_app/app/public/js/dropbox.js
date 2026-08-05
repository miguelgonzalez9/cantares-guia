// dropbox.js — acceso de SÓLO LECTURA al archivo de fotos en Dropbox, desde el
// navegador, para traer muestras sin tener que señalar la carpeta a mano.
//
// La API de Dropbox habla CORS, así que la app puede hablar con ella directamente:
// no hace falta ni servidor ni script local. Se usa OAuth con PKCE, que es el
// flujo pensado para aplicaciones que no pueden guardar un secreto — y ésta no
// puede: el repositorio es PÚBLICO y se sirve por GitHub Pages. Con PKCE la
// «app key» es pública por diseño (como la anon key de Supabase); lo que autoriza
// de verdad es el consentimiento del dueño de la cuenta más el `code_verifier`,
// que nace y muere en este dispositivo.
//
// Permisos pedidos: `files.metadata.read` y `files.content.read`. SÓLO LECTURA:
// esta app no puede escribir ni borrar nada en tu Dropbox aunque quisiera.
//
// PUESTA EN MARCHA (una vez, ~2 minutos) — ver docs/DROPBOX_MUESTRAS.md.

// App key del App Console de Dropbox. Vacía = la función queda desactivada y la
// app sigue funcionando igual, con el selector de carpeta a mano.
const APP_KEY = 've0vclsn1x8lun2';
// Carpeta raíz del archivo DENTRO de Dropbox (no la ruta del disco).
//
// LO IMPORTANTE NO ES ESTA CONSTANTE, ES EL TIPO DE APP EN DROPBOX. Con una app
// de tipo **App folder**, Dropbox sólo deja ver `Apps/<nombre>/` y el resto de la
// cuenta —escrituras, contabilidad, lo personal— es INVISIBLE para este token,
// aunque el código tuviera un fallo. Con **Full Dropbox** el token puede leerlo
// TODO y esta constante es sólo buena voluntad. Recomendado: App folder, y ahí
// `ARCHIVE_ROOT = ''`. Ver docs/DROPBOX_MUESTRAS.md.
export const ARCHIVE_ROOT = '/Cantares/fotos';

/** ¿La ruta cae dentro del archivo? Defensa en profundidad: con App folder es
 *  redundante (Dropbox ya no deja salir), con Full Dropbox es lo único que evita
 *  que un fallo pida un fichero de otra carpeta. No sustituye al permiso. */
export function insideArchive(path, root = ARCHIVE_ROOT) {
  const p = String(path || '').toLowerCase();
  const r = String(root || '').toLowerCase().replace(/\/$/, '');
  if (!r) return !p.includes('..');
  return (p === r || p.startsWith(r + '/')) && !p.includes('..');
}

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const LS = { refresh: 'cantares_dbx_refresh', verifier: 'cantares_dbx_verifier' };
const IMG_RE = /\.(jpe?g|png|webp)$/i;

let access = null, accessExp = 0;

export function dropboxConfigured() { return !!APP_KEY; }
export function dropboxLinked() { return !!localStorage.getItem(LS.refresh); }
export function dropboxUnlink() { localStorage.removeItem(LS.refresh); access = null; accessExp = 0; }

// ------------------------------------------------------------------ PKCE
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function challenge(verifier) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}
// La misma URL con la que se volverá. Sin `search` ni `hash`: Dropbox exige que
// coincida EXACTAMENTE con la registrada en el App Console.
function redirectUri() { return location.origin + location.pathname; }

/** Manda al usuario a Dropbox a dar permiso. `token_access_type=offline` es lo
 *  que devuelve un refresh token: sin él habría que volver a autorizar cada 4 h. */
export async function dropboxConnect() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  localStorage.setItem(LS.verifier, verifier);
  const p = new URLSearchParams({
    client_id: APP_KEY, response_type: 'code', redirect_uri: redirectUri(),
    code_challenge: await challenge(verifier), code_challenge_method: 'S256',
    token_access_type: 'offline', scope: 'files.metadata.read files.content.read',
  });
  location.href = `${AUTH_URL}?${p}`;
}

/** Se llama al arrancar. Si volvemos de Dropbox con `?code=`, lo canjea y limpia
 *  la URL — dejar el código a la vista invita a copiarlo en un chat. */
export async function dropboxHandleRedirect() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (!code || !APP_KEY) return false;
  const verifier = localStorage.getItem(LS.verifier);
  localStorage.removeItem(LS.verifier);
  history.replaceState({}, '', redirectUri());
  if (!verifier) return false;
  try {
    const r = await form(TOKEN_URL, { code, grant_type: 'authorization_code',
      client_id: APP_KEY, code_verifier: verifier, redirect_uri: redirectUri() });
    if (r.refresh_token) localStorage.setItem(LS.refresh, r.refresh_token);
    access = r.access_token; accessExp = Date.now() + (r.expires_in || 14400) * 1000;
    return true;
  } catch (e) { console.warn('[dropbox] canje', e && e.message); return false; }
}

async function form(url, body) {
  const res = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body) });
  if (!res.ok) throw new Error(`dropbox ${res.status}: ${(await res.text()).slice(0, 180)}`);
  return res.json();
}
// Token de acceso vivo. Se renueva con un minuto de margen: pedirlo justo al
// filo caducaría a mitad de una descarga larga.
async function token() {
  if (access && Date.now() < accessExp - 60000) return access;
  const refresh = localStorage.getItem(LS.refresh);
  if (!refresh) throw new Error('Dropbox no está conectado');
  const r = await form(TOKEN_URL, { grant_type: 'refresh_token', refresh_token: refresh, client_id: APP_KEY });
  access = r.access_token; accessExp = Date.now() + (r.expires_in || 14400) * 1000;
  return access;
}

async function rpc(path, body) {
  const res = await fetch(`${API}${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`dropbox ${path} ${res.status}: ${(await res.text()).slice(0, 180)}`);
  return res.json();
}

/** El argumento viaja en una CABECERA HTTP, que sólo admite ASCII. Los nombres
 *  del archivo llevan tildes y eñes («LÉEME», «Ñambí»), así que hay que escapar
 *  todo lo que no sea ASCII o Dropbox responde 400 y parece un fallo de permisos. */
export function headerSafeJSON(obj) {
  return JSON.stringify(obj).replace(/[-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Todas las imágenes bajo `root`, recursivo. Devuelve entradas ligeras: aquí no
 *  se baja ni un byte de imagen, sólo la lista — bajar 900 fotos para elegir 40
 *  sería tirar la conexión del sendero por la ventana. */
export async function listImages(root = ARCHIVE_ROOT) {
  const out = [];
  let r = await rpc('/files/list_folder', { path: root, recursive: true, limit: 2000 });
  for (;;) {
    for (const e of r.entries) {
      if (e['.tag'] !== 'file' || !IMG_RE.test(e.name)) continue;
      out.push({ name: e.name, path: e.path_lower, size: e.size,
        // Carpeta relativa a la raíz: es lo que se enseña para elegir y lo que
        // sirve de estrato («aves», «plantas/orquideas»).
        dir: e.path_display.slice(root.length + 1).split('/').slice(0, -1).join('/') || '(raíz)' });
    }
    if (!r.has_more) break;
    r = await rpc('/files/list_folder/continue', { cursor: r.cursor });
  }
  return out;
}

/** Baja UNA foto. Se llama sólo con las elegidas. */
export async function download(path) {
  // Nada fuera del archivo, pase lo que pase aguas arriba.
  if (!insideArchive(path)) throw new Error(`fuera del archivo: ${path}`);
  const res = await fetch(`${CONTENT}/files/download`, { method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Dropbox-API-Arg': headerSafeJSON({ path }) } });
  if (!res.ok) throw new Error(`dropbox download ${res.status}`);
  return res.blob();
}
