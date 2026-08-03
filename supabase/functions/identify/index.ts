// Cantares — Edge Function `identify`: identificación de plantas por Pl@ntNet,
// con la clave del lado del servidor y la misma guardia anti-falso-positivo que
// el motor local (data_prep/id_local.py).
//
// Por qué existe: `game.js` llamaba a Pl@ntNet desde el navegador con la clave en
// el código. Estaba vacía, así que nunca filtró nada — pero este repo es público
// y se sirve por GitHub Pages: rellenarla habría publicado la clave, y con ella
// cualquiera agota la cuota diaria de 500. La clave vive aquí o no vive.
//
// Desplegar (Supabase CLI, fuera del flujo del SQL Editor):
//   supabase secrets set PLANTNET_API_KEY=...
//   supabase functions deploy identify
// Hasta que se despliegue, la app cae al identificador manual asistido.

const PLANTNET = "https://my-api.plantnet.org/v2/identify/all";

// Mismos criterios que id_local.py. Cambiarlos aquí sin cambiarlos allá hace que
// la misma foto se clasifique distinto según por dónde entre.
const SCORE_MIN = 0.40;   // score mínimo del primer candidato
const MARGIN_MIN = 0.10;  // ventaja mínima sobre el segundo
const MAX_BYTES = 8 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",   // lectura pública; la clave nunca sale de aquí
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

/** Normaliza un nombre científico para comparar: sin acentos, sin autor, minúsculas.
 *  Pl@ntNet devuelve «Panopsis suaveolens» y el inventario puede traer variantes. */
export function normSci(s: string): string {
  return (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

/** Decide qué se devuelve. Es la única lógica que importa, y es pura a propósito:
 *  se puede probar sin red y sin clave (ver identify.test.ts).
 *
 *  `inventory` = Map(nombre científico normalizado → id de especie de la app).
 *  Un candidato fuera del inventario NUNCA se asigna — Pl@ntNet conoce ~50.000
 *  especies del mundo y la reserva tiene ~700, así que su primera propuesta suele
 *  ser una especie que aquí no existe. Pero tampoco se descarta en silencio: sale
 *  marcado como posible hallazgo nuevo, que es información para el inventario. */
export function decide(
  candidates: { sci: string; common: string; score: number }[],
  inventory: Map<string, string>,
) {
  if (!candidates.length) return { verdict: "abstain", reason: "sin candidatos", candidates: [] };

  const ranked = candidates.map((c) => ({ ...c, speciesId: inventory.get(normSci(c.sci)) ?? null }));
  const inHouse = ranked.filter((c) => c.speciesId);

  if (!inHouse.length) {
    return {
      verdict: "outside-inventory",
      reason: `«${ranked[0].sci}» no está en el inventario de la reserva`,
      candidates: ranked.slice(0, 5),
    };
  }
  // El margen se mide contra el SEGUNDO del inventario, no contra el segundo
  // global: si Pl@ntNet duda entre dos especies que aquí no existen, eso no
  // debería restarle confianza a la que sí existe.
  const top = inHouse[0];
  const second = inHouse[1]?.score ?? 0;
  if (top.score < SCORE_MIN) {
    return { verdict: "abstain", reason: `score bajo (${top.score.toFixed(2)} < ${SCORE_MIN})`,
             candidates: ranked.slice(0, 5) };
  }
  if (top.score - second < MARGIN_MIN) {
    return { verdict: "abstain", reason: `margen bajo (${top.score.toFixed(2)} vs ${second.toFixed(2)})`,
             candidates: ranked.slice(0, 5) };
  }
  return { verdict: "ok", speciesId: top.speciesId, sci: top.sci, common: top.common,
           score: top.score, candidates: ranked.slice(0, 5) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "usa POST" }, 405);

  const key = Deno.env.get("PLANTNET_API_KEY");
  // Sin clave la función NO inventa: dice que no está configurada y el cliente
  // cae al identificador manual. Fallar en silencio sería peor.
  if (!key) return json({ verdict: "unavailable", reason: "PLANTNET_API_KEY sin configurar" }, 503);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "se esperaba multipart/form-data con `image`" }, 400);
  }
  const image = form.get("image");
  if (!(image instanceof File)) return json({ error: "falta el campo `image`" }, 400);
  if (image.size > MAX_BYTES) return json({ error: "imagen demasiado grande" }, 413);

  // El inventario lo manda el cliente (ya lo tiene cargado) como [[sci, id], ...].
  // Así la función no necesita leer la base ni versionar species.json.
  let inventory = new Map<string, string>();
  try {
    const raw = form.get("inventory");
    if (typeof raw === "string") {
      inventory = new Map((JSON.parse(raw) as [string, string][])
        .map(([sci, id]) => [normSci(sci), id]));
    }
  } catch {
    return json({ error: "`inventory` no es JSON válido" }, 400);
  }
  if (!inventory.size) return json({ error: "`inventory` vacío: sin él no hay guardia" }, 400);

  const out = new FormData();
  out.append("images", image, "photo.jpg");
  out.append("organs", "auto");
  const lang = (form.get("lang") as string) === "en" ? "en" : "es";

  let res: Response;
  try {
    res = await fetch(`${PLANTNET}?api-key=${encodeURIComponent(key)}&lang=${lang}`,
                      { method: "POST", body: out });
  } catch (e) {
    return json({ verdict: "unavailable", reason: `Pl@ntNet no responde: ${e}` }, 502);
  }
  if (res.status === 429) {
    // Cuota diaria agotada (500 gratis, compartidas con los lotes locales). No es
    // un error del visitante: que la app lo diga y ofrezca el modo manual.
    return json({ verdict: "quota", reason: "cuota diaria de Pl@ntNet agotada" }, 200);
  }
  if (!res.ok) return json({ verdict: "unavailable", reason: `Pl@ntNet ${res.status}` }, 502);

  const body = await res.json();
  const candidates = (body.results ?? []).slice(0, 8).map((r: any) => ({
    sci: r.species?.scientificNameWithoutAuthor ?? "",
    common: (r.species?.commonNames ?? [])[0] ?? "",
    score: r.score ?? 0,
  })).filter((c: any) => c.sci);

  return json(decide(candidates, inventory));
});
