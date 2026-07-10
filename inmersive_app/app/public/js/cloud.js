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
  const { data } = await c.from('profiles').select('username, role').eq('id', _session.user.id).maybeSingle();
  _profile = data || { username: _session.user.email.split('@')[0], role: 'visitor' };
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

export async function upsertWaypoint(w) { const c = await getClient(); const { error } = await c.from('waypoints').upsert(w); if (error) throw error; }
export async function deleteWaypoint(id) { const c = await getClient(); const { error } = await c.from('waypoints').delete().eq('id', id); if (error) throw error; }
export async function upsertSpecies(s) { const c = await getClient(); const { error } = await c.from('species').upsert(s); if (error) throw error; }
export async function deleteSpecies(id) { const c = await getClient(); const { error } = await c.from('species').delete().eq('id', id); if (error) throw error; }
export async function upsertTrail(tr) { const c = await getClient(); const { error } = await c.from('trails').upsert(tr); if (error) throw error; }
export async function deleteTrail(id) { const c = await getClient(); const { error } = await c.from('trails').delete().eq('id', id); if (error) throw error; }

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

// ---------- imágenes (Supabase Storage, bucket público "media") ----------
export async function uploadImage(file, folder = 'uploads') {
  const c = await getClient();
  const clean = String(file.name || 'img').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${folder}/${Date.now()}_${clean}`;
  const { error } = await c.storage.from('media').upload(path, file, { upsert: false, cacheControl: '3600' });
  if (error) throw error;
  return c.storage.from('media').getPublicUrl(path).data.publicUrl;
}
