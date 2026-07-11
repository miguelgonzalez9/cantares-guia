// Cantares — mantener la pantalla encendida mientras se graba GPS.
// (Screen Wake Lock API: es lo que hacen Google Maps/Strava en navegación.)
// Los navegadores suspenden el GPS de una web cuando la pantalla se apaga, así
// que durante una grabación pedimos que NO se apague. Si el sistema quita el
// lock (cambiar de app, bloquear a mano), se re-adquiere solo al volver.
// En navegadores sin soporte (iOS < 16.4) no hace nada y la grabación sigue.

let sentinel = null, wanted = false;

async function acquire() {
  if (!('wakeLock' in navigator)) return false;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => { sentinel = null; });
    return true;
  } catch (e) { sentinel = null; return false; }   // batería baja, política del SO…
}

document.addEventListener('visibilitychange', () => {
  if (wanted && !document.hidden && !sentinel) acquire();
});

// keepAwake() → true si la pantalla quedará encendida; false si el navegador
// no lo permite (avisar al usuario que no apague la pantalla).
export async function keepAwake() { wanted = true; return acquire(); }
export function releaseAwake() {
  wanted = false;
  if (sentinel) { try { sentinel.release(); } catch (e) { /* ya liberado */ } sentinel = null; }
}
