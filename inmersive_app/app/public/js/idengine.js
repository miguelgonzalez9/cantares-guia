// Cantares — motor de identificación, un solo punto de entrada para toda la app.
// Lo usan el juego (visitante fotografía una planta) y la bandeja de fotos del
// admin. Detrás llama a la Edge Function `identify`, que guarda la clave de
// Pl@ntNet del lado del servidor y aplica la guardia de conjunto cerrado contra
// el inventario de la reserva.
//
// Sustituye a la llamada directa que había en game.js con la clave en el código:
// este repo es público y se sirve por GitHub Pages, así que esa clave habría
// quedado publicada. Ver docs/ID_COMUNIDAD.md.
//
// Degrada siempre: sin red, sin función desplegada o con la cuota agotada
// devuelve un veredicto explicativo y quien llama cae al identificador manual.
// Nunca lanza por un fallo de identificación — eso es normal, no excepcional.
import { cloudConfigured, cloudUrl, anonKey } from './cloud.js';

const TIMEOUT = 20000;

// Veredictos posibles (los tres primeros vienen de la función; los otros son locales):
//   ok                 → especie del inventario con score y margen suficientes
//   abstain            → hay candidatos pero no alcanzan el umbral o el margen
//   outside-inventory  → la mejor propuesta no existe en la reserva (posible hallazgo)
//   quota              → se agotaron las 500 identificaciones del día
//   unavailable        → sin red, sin función desplegada o sin clave configurada
export const VERDICTS = ['ok', 'abstain', 'outside-inventory', 'quota', 'unavailable'];

/** ¿Está disponible la identificación automática? Sirve para no mostrar el botón
 *  cuando no puede funcionar (mejor que mostrarlo y que falle al tocarlo). */
export function idAvailable() { return cloudConfigured() && navigator.onLine; }

/** Identifica una planta. `species` = el inventario cargado (state.species).
 *  Devuelve siempre un objeto con `verdict`; nunca lanza. */
export async function identifyPlant(blob, species, lang = 'es') {
  if (!blob) return { verdict: 'unavailable', reason: 'sin imagen' };
  if (!idAvailable()) return { verdict: 'unavailable', reason: 'sin conexión' };

  // El inventario viaja con la petición: la función no lee la base ni versiona
  // species.json, así que añadir una especie en la app la hace identificable al
  // instante, sin re-desplegar nada.
  const inventory = (species || [])
    .filter((s) => s.scientific_name)
    .map((s) => [s.scientific_name, s.id]);
  if (!inventory.length) return { verdict: 'unavailable', reason: 'inventario vacío' };

  const fd = new FormData();
  fd.append('image', blob, 'photo.jpg');
  fd.append('inventory', JSON.stringify(inventory));
  fd.append('lang', lang);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${cloudUrl()}/functions/v1/identify`, {
      method: 'POST', body: fd, signal: ctrl.signal,
      headers: { Authorization: `Bearer ${anonKey()}` },
    });
    // 404 = la función no está desplegada todavía. Es el estado por defecto
    // hasta que se corra `supabase functions deploy identify`, así que se trata
    // como "no disponible" y no como error.
    if (res.status === 404) return { verdict: 'unavailable', reason: 'identificación no desplegada' };
    if (!res.ok && res.status !== 200) {
      const body = await res.json().catch(() => ({}));
      return { verdict: 'unavailable', reason: body.reason || `error ${res.status}` };
    }
    return await res.json();
  } catch (e) {
    return { verdict: 'unavailable', reason: e.name === 'AbortError' ? 'tardó demasiado' : 'sin conexión' };
  } finally {
    clearTimeout(timer);
  }
}

/** Texto para el usuario a partir del veredicto. En un solo sitio para que el
 *  juego y el panel de admin digan lo mismo. */
export function verdictText(r, lang = 'es') {
  const ES = {
    abstain: 'No estoy seguro. Mejor elígela a mano — antes sin clasificar que mal clasificada.',
    'outside-inventory': 'Se parece a una especie que no está en el inventario de la reserva. Puede ser un hallazgo: déjala sin clasificar y avisa.',
    quota: 'Hoy se agotaron las identificaciones automáticas. Elígela a mano.',
    unavailable: 'La identificación automática no está disponible. Elígela a mano.',
  };
  const EN = {
    abstain: "Not sure. Pick it by hand — better unclassified than misclassified.",
    'outside-inventory': "Looks like a species that isn't in the reserve inventory. It could be a new record: leave it unclassified and let us know.",
    quota: 'Automatic identification is used up for today. Pick it by hand.',
    unavailable: 'Automatic identification is unavailable. Pick it by hand.',
  };
  return (lang === 'en' ? EN : ES)[r && r.verdict] || '';
}
