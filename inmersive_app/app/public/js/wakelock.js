// Cantares — mantener la pantalla encendida mientras se graba GPS.
// (Screen Wake Lock API: es lo que hacen Google Maps/Strava en navegación.)
// Los navegadores suspenden el GPS de una web cuando la pantalla se apaga, así
// que durante una grabación pedimos que NO se apague. Si el sistema quita el
// lock (cambiar de app, bloquear a mano), se re-adquiere solo al volver.
// En navegadores sin soporte (iOS < 16.4) no hace nada y la grabación sigue.

// El lock lo piden DOS dueños a la vez: el modo guiado y el grabador de
// caminatas. Con una sola bandera, el primero en soltar apagaba la pantalla
// aunque el otro siguiera caminando — y sin pantalla el navegador corta el GPS,
// así que los avisos de llegada a los puntos morían en silencio. Por eso se
// cuentan los dueños y sólo se libera cuando no queda ninguno.
let sentinel = null, holders = 0;

async function acquire() {
  if (!('wakeLock' in navigator)) return false;
  if (sentinel) return true;                       // ya encendida: no pedir dos
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => { sentinel = null; });
    return true;
  } catch (e) { sentinel = null; return false; }   // batería baja, política del SO…
}

document.addEventListener('visibilitychange', () => {
  if (holders > 0 && !document.hidden && !sentinel) acquire();
});

// keepAwake() → true si la pantalla quedará encendida; false si el navegador
// no lo permite (avisar al usuario que no apague la pantalla).
// Cada keepAwake() necesita su releaseAwake(); están emparejados.
export async function keepAwake() { holders++; return acquire(); }
export function releaseAwake() {
  holders = Math.max(0, holders - 1);
  if (holders > 0) return;                         // otro dueño sigue caminando
  if (sentinel) { try { sentinel.release(); } catch (e) { /* ya liberado */ } sentinel = null; }
}
// Para cortar de raíz (cerrar sesión, terminar todo): suelta pase lo que pase.
export function releaseAwakeAll() { holders = 0; releaseAwake(); }
