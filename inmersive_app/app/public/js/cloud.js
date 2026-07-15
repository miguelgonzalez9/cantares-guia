// Cantares — capa de nube (Supabase): cuentas, progreso global e inventario
// compartido + edición de contenido para admins. TODO está desactivado hasta
// que se llenen las credenciales abajo; sin ellas la app funciona igual que
// antes (estática, juego local, sin login obligatorio). Ver docs/BACKEND_SUPABASE.md
//
// El `anonKey` de Supabase es PÚBLICO por diseño (las políticas RLS protegen los
// datos), así que es seguro versionarlo. Pega aquí los dos valores de tu proyecto.
const CLOUD = {
  url:     'https://rmfwrzteuraatdutwaqj.supabase.co',   // p.ej. https://xxxxxxxx.supabase.co
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJtZndyenRldXJhYXRkdXR3YXFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2NDgzNDksImV4cCI6MjA5OTIyNDM0OX0.yZkgGiEY8HtLwGUzSqrj670gTcpP6JqX1l7xFfgLli0',   // clave "anon public" del panel de Supabase
};

const EMAIL_DOMAIN = 'cantares.local';   // usuarios usan username; internamente = username@cantares.local
const SDK = 'https://esm.sh/@supabase/supabase-js@2';

let client = null, _session = null, _profile = null;

export function cloudConfigured() { return !!(CLOUD.url && CLOUD.anonKey); }

async function getClient() {
  if (client) return client;
  const { createClient } = await import(/* @vite-ignore */ SDK);
  client = createClient(CLOUD.url, CLOUD.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'cantares_auth' },
  });
  return client;
}

// Llamar una vez al arrancar. Devuelve {enabled, user}. Nunca lanza: si la nube
// falla (offline, mal configurada), la app cae a modo local.
export async function cloudInit() {
  if (!cloudConfigured()) return { enabled: false, user: null };
  try {
    const c = await getClient();
    const { data } = await c.auth.getSession();
    _session = data.session || null;
    if (_session) await loadProfile();
    c.auth.onAuthStateChange((_e, s) => { _session = s || null; });
    return { enabled: true, user: currentUser() };
  } catch (e) {
    console.warn('[cloud] init falló, modo local:', e && e.message);
    return { enabled: false, user: null };
  }
}

const emailFor = (u) => `${String(u).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')}@${EMAIL_DOMAIN}`;

async function loadProfile() {
  const c = await getClient();
  if (!_session) { _profile = null; return null; }
  const cacheKey = 'cantares_profile_' + _session.user.id;
  // Con señal: leer el perfil real y cachearlo. Sin señal: usar el cacheado, para
  // que el modo admin siga funcionando offline (los cambios esperan en la cola).
  try {
    const { data } = await c.from('profiles').select('username, role').eq('id', _session.user.id).maybeSingle();
    if (data) {
      _profile = data;
      try { localStorage.setItem(cacheKey, JSON.stringify(data)); localStorage.setItem('cantares_role', data.role || 'visitor'); } catch (e) { /* storage lleno */ }
      return _profile;
    }
  } catch (e) { /* offline / red caída → cache */ }
  try { const cached = localStorage.getItem(cacheKey); if (cached) { _profile = JSON.parse(cached); return _profile; } } catch (e) { /* json corrupto */ }
  _profile = { username: _session.user.email.split('@')[0], role: localStorage.getItem('cantares_role') || 'visitor' };
  return _profile;
}

export function currentUser() {
  if (!_session) return null;
  return { id: _session.user.id, username: (_profile && _profile.username) || '', role: (_profile && _profile.role) || 'visitor' };
}
export function isLoggedIn() { return !!_session; }
export function isAdmin() { return !!(_profile && _profile.role === 'admin'); }

export async function signUpVisitor(username, password) {
  const c = await getClient();
  const { data, error } = await c.auth.signUp({ email: emailFor(username), password, options: { data: { username } } });
  if (error) throw prettyAuthError(error);
  _session = data.session || null;
  // Con confirmación de email desactivada, signUp ya deja sesión activa.
  if (_session) await loadProfile();
  else { await signIn(username, password); }   // por si el proyecto autoconfirma sin sesión
  return currentUser();
}
export async function signIn(username, password) {
  const c = await getClient();
  const { data, error } = await c.auth.signInWithPassword({ email: emailFor(username), password });
  if (error) throw prettyAuthError(error);
  _session = data.session || null;
  await loadProfile();
  return currentUser();
}
export async function signOut() {
  const c = await getClient();
  await c.auth.signOut();
  _session = null; _profile = null;
  try { localStorage.removeItem('cantares_role'); } catch (e) { /* ignore */ }
}
function prettyAuthError(e) {
  const m = (e && e.message) || '';
  if (/already registered/i.test(m)) return new Error('Ese usuario ya existe. Inicia sesión.');
  if (/invalid login/i.test(m))      return new Error('Usuario o contraseña incorrectos.');
  if (/at least 6/i.test(m))         return new Error('La contraseña debe tener al menos 6 caracteres.');
  return e;
}

// ---------- datos (lectura pública; escritura sólo admin por RLS) ----------
async function sel(table) { const c = await getClient(); const { data, error } = await c.from(table).select('*'); if (error) throw error; return data || []; }
export const listWaypoints = () => sel('waypoints');
export const listSpecies   = () => sel('species');
export const listTrails    = () => sel('trails');
export const listRoutes    = () => sel('routes');

export async function upsertWaypoint(w) { const c = await getClient(); const { error } = await c.from('waypoints').upsert(w); if (error) throw error; }
export async function deleteWaypoint(id) { const c = await getClient(); const { error } = await c.from('waypoints').delete().eq('id', id); if (error) throw error; }
export async function upsertSpecies(s) { const c = await getClient(); const { error } = await c.from('species').upsert(s); if (error) throw error; }
export async function deleteSpecies(id) { const c = await getClient(); const { error } = await c.from('species').delete().eq('id', id); if (error) throw error; }
export async function upsertTrail(tr) { const c = await getClient(); const { error } = await c.from('trails').upsert(tr); if (error) throw error; }
export async function deleteTrail(id) { const c = await getClient(); const { error } = await c.from('trails').delete().eq('id', id); if (error) throw error; }
export async function upsertRoute(r) { const c = await getClient(); const { error } = await c.from('routes').upsert(r); if (error) throw error; }
export async function deleteRoute(id) { const c = await getClient(); const { error } = await c.from('routes').delete().eq('id', id); if (error) throw error; }

// Tipos de punto (color/emoji/nombre) compartidos entre dispositivos. La tabla
// point_types (migración 19) guarda sólo los que crea/edita el admin; los base
// viven en el código. Lectura pública; escritura sólo admin (RLS).
export const listPointTypes = () => sel('point_types');
export async function upsertPointType(pt) { const c = await getClient(); const { error } = await c.from('point_types').upsert(pt); if (error) throw error; }
export async function deletePointType(id) { const c = await getClient(); const { error } = await c.from('point_types').delete().eq('id', id); if (error) throw error; }

// ---------- medios (fotos + videos): tabla runtime, espejo de media.json ----------
export const listMedia = () => sel('media');
export async function upsertMedia(m) {
  const c = await getClient();
  // Un visitante sólo puede contribuir fotos sin clasificar (RLS); el admin, todo.
  const row = { ...m };
  if (!isAdmin()) { const u = currentUser(); row.contributor = u ? u.id : null; row.status = 'unclassified'; }
  const { error } = await c.from('media').upsert(row);
  if (error) throw error;
}
export async function deleteMedia(id) { const c = await getClient(); const { error } = await c.from('media').delete().eq('id', id); if (error) throw error; }

// ---------- inventario global (sightings) + progreso del visitante ----------
export async function listSightings() { return sel('sightings'); }
export async function addSighting(s) {
  const c = await getClient();
  const u = currentUser();
  const row = { ...s, user_id: u ? u.id : null };
  const { data, error } = await c.from('sightings').insert(row).select().single();
  if (error) throw error;
  return data;
}
export async function mySightings() {
  const c = await getClient();
  const u = currentUser();
  if (!u) return [];
  const { data, error } = await c.from('sightings').select('*').eq('user_id', u.id);
  if (error) throw error;
  return data || [];
}

// Avistamiento idempotente para la cola offline: upsert por client_id (el id
// local del teléfono), así un reintento tras señal intermitente no duplica.
export async function upsertSighting(s) {
  const c = await getClient();
  const u = currentUser();
  if (!u) throw new Error('Sesión requerida para subir avistamientos');
  const row = { ...s, user_id: u.id };
  delete row.id;   // el id lo genera la base
  let { error } = await c.from('sightings').upsert(row, { onConflict: 'client_id' });
  if (error && /client_id/i.test(error.message || '')) {
    // Migración 14 aún no corrida: caer a insert simple (no idempotente).
    ({ error } = await c.from('sightings').insert(row));
  }
  if (error) throw error;
}

// ---------- caminatas del visitante (privadas; siguen al usuario) ----------
export async function upsertWalk(w) {
  const c = await getClient();
  const u = currentUser();
  if (!u) throw new Error('Sesión requerida para subir caminatas');
  const { error } = await c.from('walks').upsert({ ...w, user_id: u.id });
  if (error) throw error;
}
export async function listMyWalks() {
  const c = await getClient();
  const u = currentUser();
  if (!u) return [];
  const { data, error } = await c.from('walks').select('*').eq('user_id', u.id);
  if (error) throw error;
  return data || [];
}
export async function deleteWalkCloud(id) {
  const c = await getClient();
  const { error } = await c.from('walks').delete().eq('id', id);
  if (error) throw error;
}

// ---------- imágenes (Supabase Storage, bucket público "media") ----------
export async function uploadImage(file, folder = 'uploads') {
  const c = await getClient();
  const clean = String(file.name || 'img').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${folder}/${Date.now()}_${clean}`;
  const { error } = await c.storage.from('media').upload(path, file, { upsert: false, cacheControl: '3600' });
  if (error) throw error;
  return c.storage.from('media').getPublicUrl(path).data.publicUrl;
}
