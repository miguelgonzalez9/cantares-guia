// Cantares — pantalla de entrada (login). Diverge en visitante (crea cuenta) /
// admin (mismo login, rol detectado por el servidor) / invitado. Se auto-inyecta
// en el DOM. Si la nube está desactivada, no aparece (la app sigue como antes).
import { cloudConfigured, cloudInit, currentUser, isAdmin, signIn, signUpVisitor, signOut } from './cloud.js';

// ── PARÁMETRO: exigir estar DENTRO de la reserva para crear/entrar a una cuenta
// de visitante. Ponlo en false para desactivar el geocerco (los admins nunca se
// bloquean por ubicación; el modo invitado tampoco lo requiere).
const REQUIRE_IN_RESERVE = true;
const BOUNDARY_URL = 'data/boundary.geojson';

const S = {
  es: {
    welcome: 'Bienvenido a Cantares', tagline: 'Guía de la reserva',
    guest: 'Explorar como invitado', account_h: 'Entra para guardar tu progreso',
    user: 'Usuario', pass: 'Contraseña', login: 'Entrar', signup: 'Crear cuenta',
    or: 'o', have_progress: 'Tu progreso y avistamientos quedan guardados y te siguen entre dispositivos.',
    admin_hint: '¿Administras la reserva? Entra con tu usuario de admin.',
    working: 'Un momento…', logout: 'Salir', hi: 'Hola',
    err_fields: 'Escribe usuario y contraseña.',
    geo_note: '📍 Para crear o entrar a una cuenta de visitante debes estar dentro de la reserva.',
    geo_checking: 'Verificando que estés en la reserva…',
    geo_outside: 'Debes estar dentro de la Reserva Cantares para usar una cuenta de visitante.',
    geo_denied: 'Activa el permiso de ubicación para entrar como visitante.',
    geo_unavailable: 'No pudimos verificar tu ubicación. Inténtalo al aire libre, dentro de la reserva.',
  },
  en: {
    welcome: 'Welcome to Cantares', tagline: 'Reserve guide',
    guest: 'Explore as guest', account_h: 'Log in to save your progress',
    user: 'Username', pass: 'Password', login: 'Log in', signup: 'Sign up',
    or: 'or', have_progress: 'Your progress and sightings are saved and follow you across devices.',
    admin_hint: 'Managing the reserve? Log in with your admin account.',
    working: 'One moment…', logout: 'Log out', hi: 'Hi',
    err_fields: 'Enter a username and password.',
    geo_note: '📍 You must be inside the reserve to create or enter a visitor account.',
    geo_checking: 'Checking you are at the reserve…',
    geo_outside: 'You must be inside Cantares Reserve to use a visitor account.',
    geo_denied: 'Enable the location permission to enter as a visitor.',
    geo_unavailable: "We couldn't verify your location. Try outdoors, inside the reserve.",
  },
};

let LANG = 'es';
const t = (k) => (S[LANG] && S[LANG][k]) || S.es[k] || k;

// ── Geocerco: ¿está el usuario dentro del polígono de la reserva? ──
let _boundary = null;
async function loadBoundary() {
  if (_boundary) return _boundary;
  const res = await fetch(BOUNDARY_URL);
  _boundary = await res.json();
  return _boundary;
}
function pointInRing(pt, ring) {   // ray casting; pt y ring en [lng,lat]
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function inGeoJSON(pt, gj) {
  const feats = gj.type === 'FeatureCollection' ? gj.features : [gj];
  for (const f of feats) {
    const g = f.geometry || f; if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      if (pointInRing(pt, poly[0])) {
        let hole = false;
        for (let k = 1; k < poly.length; k++) if (pointInRing(pt, poly[k])) { hole = true; break; }
        if (!hole) return true;
      }
    }
  }
  return false;
}
function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ reason: 'unavailable' });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ coords: [p.coords.longitude, p.coords.latitude] }),
      (e) => resolve({ reason: e.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
}
// { ok, reason: 'ok' | 'denied' | 'unavailable' | 'outside' }
async function checkInReserve() {
  if (!REQUIRE_IN_RESERVE) return { ok: true, reason: 'ok' };
  const pos = await getPosition();
  if (pos.reason) return { ok: false, reason: pos.reason };
  try {
    const inside = inGeoJSON(pos.coords, await loadBoundary());
    return { ok: inside, reason: inside ? 'ok' : 'outside' };
  } catch (e) { return { ok: false, reason: 'unavailable' }; }
}
const geoMsg = (reason) => t(reason === 'denied' ? 'geo_denied' : reason === 'outside' ? 'geo_outside' : 'geo_unavailable');

// Devuelve { enabled, user } y muestra la puerta si hace falta. `onEnter` se
// llama cuando el usuario decide continuar (invitado o autenticado).
export async function initAuthGate({ lang, onEnter, onAuthChange }) {
  LANG = lang || 'es';
  if (!cloudConfigured()) { onEnter({ guest: true, user: null }); return { enabled: false }; }

  const info = await cloudInit();
  if (!info.enabled) { onEnter({ guest: true, user: null }); return { enabled: false }; }

  // Sesión previa → entra directo (progreso restaurado).
  if (currentUser()) { onAuthChange && onAuthChange(currentUser()); onEnter({ guest: false, user: currentUser() }); return { enabled: true, user: currentUser() }; }
  // ¿Eligió invitado antes en este dispositivo?
  if (localStorage.getItem('cantares_guest') === '1') { onEnter({ guest: true, user: null }); return { enabled: true, user: null }; }

  renderGate({ onEnter, onAuthChange });
  return { enabled: true, user: null };
}

function renderGate({ onEnter, onAuthChange }) {
  let el = document.getElementById('auth-gate');
  if (!el) { el = document.createElement('div'); el.id = 'auth-gate'; el.className = 'auth-gate'; document.body.appendChild(el); }
  el.innerHTML = `
    <div class="auth-card">
      <img src="icons/icon.svg" class="auth-logo" alt="" />
      <h1>${t('welcome')}</h1>
      <p class="auth-tag">${t('tagline')}</p>
      <div class="auth-langs">
        <button class="auth-lang ${LANG === 'es' ? 'sel' : ''}" data-l="es">Español</button>
        <button class="auth-lang ${LANG === 'en' ? 'sel' : ''}" data-l="en">English</button>
      </div>
      <h2 class="auth-h2">${t('account_h')}</h2>
      ${REQUIRE_IN_RESERVE ? `<p class="auth-geo">${t('geo_note')}</p>` : ''}
      <form id="auth-form" autocomplete="on">
        <input id="auth-user" class="auth-in" type="text" placeholder="${t('user')}" autocomplete="username" />
        <input id="auth-pass" class="auth-in" type="password" placeholder="${t('pass')}" autocomplete="current-password" />
        <div class="auth-err" id="auth-err"></div>
        <div class="auth-btns">
          <button type="submit" class="auth-btn primary" data-act="login">${t('login')}</button>
          <button type="button" class="auth-btn" data-act="signup">${t('signup')}</button>
        </div>
      </form>
      <p class="auth-note">${t('have_progress')}</p>
      <div class="auth-sep"><span>${t('or')}</span></div>
      <button class="auth-guest" id="auth-guest">${t('guest')}</button>
      <p class="auth-admin">${t('admin_hint')}</p>
    </div>`;

  el.querySelectorAll('.auth-lang').forEach((b) => b.onclick = () => { LANG = b.dataset.l; renderGate({ onEnter, onAuthChange }); });
  const err = (m) => { const e = document.getElementById('auth-err'); e.textContent = m || ''; e.style.display = m ? 'block' : 'none'; };
  const busy = (on) => el.querySelectorAll('button,input').forEach((n) => n.disabled = on);
  const creds = () => [document.getElementById('auth-user').value.trim(), document.getElementById('auth-pass').value];

  const done = () => { el.remove(); if (onAuthChange) onAuthChange(currentUser()); onEnter({ guest: false, user: currentUser() }); };
  const attempt = async (fn) => {
    const [u, p] = creds();
    if (!u || !p) { err(t('err_fields')); return; }
    err(''); busy(true);
    try { await fn(u, p); done(); }
    catch (e) { err(e.message || String(e)); busy(false); }
  };
  // Login: los admins entran desde cualquier lugar; los visitantes deben estar
  // dentro de la reserva (geocerco).
  const doLogin = async (u, p) => {
    await signIn(u, p);
    if (isAdmin()) return;
    err(t('geo_checking'));
    const geo = await checkInReserve();
    if (!geo.ok) { await signOut(); throw new Error(geoMsg(geo.reason)); }
  };
  // Crear cuenta (siempre visitante): exige estar dentro de la reserva.
  const doSignup = async (u, p) => {
    err(t('geo_checking'));
    const geo = await checkInReserve();
    if (!geo.ok) throw new Error(geoMsg(geo.reason));
    return signUpVisitor(u, p);
  };
  document.getElementById('auth-form').onsubmit = (ev) => { ev.preventDefault(); attempt(doLogin); };
  el.querySelector('[data-act="signup"]').onclick = () => attempt(doSignup);
  document.getElementById('auth-guest').onclick = () => { localStorage.setItem('cantares_guest', '1'); el.remove(); onEnter({ guest: true, user: null }); };
}

// Cerrar sesión → limpia elección de invitado y recarga a la puerta.
export async function doLogout() {
  try { await signOut(); } catch (e) { /* ignore */ }
  localStorage.removeItem('cantares_guest');
  location.reload();
}
export { isAdmin, currentUser };
