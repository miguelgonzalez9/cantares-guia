# Motor de identificación de especies — plan de arquitectura

Plan para el componente de IA del juego «Expedición Cantares»: identificar
plantas, árboles, aves, mamíferos, anfibios e insectos a partir de una foto, y
machearlos con el inventario de la reserva. Basado en investigación de las APIs
disponibles a 2025-2026 (iNaturalist, Pl@ntNet, Google Vision, BirdNET, eBird,
SpeciesNet). Reserva: bosque muy húmedo montano andino, ~Manizales, Colombia.

---

## 0. La conclusión honesta (leer esto primero)

**No existe una sola API que identifique bien todo.** La realidad del mercado:

- **Plantas** → **Pl@ntNet** es la *única* API limpia, documentada y de auto-registro.
  Gratis 500/día. Es tu único taxón que «simplemente funciona».
- **Aves (por foto)** → **no existe ninguna API pública**. Merlin es solo-app;
  iNaturalist está cerrado. La vía real para aves es **sonido** (BirdNET, se
  auto-hospeda) + **eBird** para una lista local de especies probables.
- **Mamíferos** → **SpeciesNet/MegaDetector** de Google (Apache-2.0, se auto-hospeda;
  afinado para cámaras trampa).
- **Anfibios / reptiles / insectos / hongos** → **iNaturalist** es el techo de
  calidad, pero su modelo de visión **no es API pública** (acceso caso-por-caso,
  de pago). Sin ese acceso, solo queda Google Vision con etiquetas gruesas.
- **Comodín general** → **Google Cloud Vision**: barato, rápido, pero da
  «planta / ave / escarabajo», no la especie. Sirve de red de seguridad y para
  *enrutar* al proveedor correcto.

**Implicación de diseño:** el «motor» NO es una API — es un **enrutador** que
manda cada foto al mejor proveedor según el grupo, **sesga** el resultado a las
especies que de verdad viven en la reserva (prior geográfico + inventario), y
**mantiene al humano en el bucle** (nunca afirma una especie en silencio). Los
proveedores viven detrás de un **proxy** que protege las claves.

**El punto estratégico clave:** ese proxy y el inventario global viven en el
**mismo backend** que necesitas para las cuentas de visitante/admin y el
almacenamiento de progreso. Una sola decisión de backend (**Supabase**) resuelve
el motor de IA *y* el objetivo de login/almacenamiento global. No son dos
proyectos: son uno.

---

## 1. Arquitectura de referencia

```
GitHub Pages — PWA (bilingüe, offline)
  • cámara → reduce a ~1024px (Canvas) antes de subir
  • router en el dispositivo (MobileNet/EfficientNet ~5–10MB, TF.js/ONNX,
      cacheado en IndexedDB): ¿planta / ave / mamífero / anfibio / insecto?
      → funciona offline, filtra fotos malas, elige proveedor
  • Service Worker: shell offline + caché del modelo
            │  (solo al tocar «Identificar»; HTTPS + CORS restringido)
            ▼
┌───────────────────────────────────────────────────────────────┐
│  BACKEND — Supabase (un solo proyecto)                          │
│                                                               │
│  Edge Function = PROXY DE VISIÓN  (claves solo del lado server)│
│    • límite por usuario/IP + tope de presupuesto mensual       │
│    • caché por hash de imagen  → [acierto? devuelve cacheado]   │
│    • enruta: planta→Pl@ntNet · animal→Vision · (herp/insecto→   │
│      iNat si hay acceso)                                        │
│    • RE-RANKEA candidatos ∩ inventario de la reserva + estación │
│    • umbral de confianza → «necesita revisión» si es bajo       │
│                                                               │
│  Auth      → cuentas de visitante + 1 admin (RLS)              │
│  Postgres  → progreso, avistamientos, cola de revisión,        │
│              INVENTARIO de especies (Studio = panel admin)      │
│  Storage   → fotos aportadas (opt-in, reducidas)               │
└───────────────────────────┬───────────────────────────────────┘
                            │  (la clave nunca llega al navegador)
                            ▼
     Pl@ntNet (gratis ≤500/día)  ·  Google Vision ($1.50/1k tras 1k gratis)
                            │
            [aviso de consentimiento + ToS antes de la 1ª subida]

  Keep-alive: cron de GitHub Actions pinguea el backend cada ~3 días
  Fallback: offline / sin presupuesto / API caída → solo modelo on-device
```

---

## 2. Enrutamiento por taxón (la decisión práctica)

Con foto + grupo (que el router o el usuario eligen), y **siempre** adjuntando las
coordenadas fijas de la reserva + la fecha:

| Grupo | Proveedor primario | Fallback | ¿API pública? | Costo |
|---|---|---|---|---|
| Plantas/árboles/flores | **Pl@ntNet** (`/v2/identify/all`, multi-órgano) | Vision (grueso) | **Sí** | Gratis 500/día |
| Aves (sonido) | **BirdNET** (auto-hospedado, lat/lon/semana) | — | Modelo abierto, sin API alojada | Solo cómputo |
| Aves (foto) | *ninguna con API* — iNat si hay acceso | **lista local eBird + selector manual** | No | — |
| Mamíferos | **SpeciesNet** (auto-hospedado) | iNat → Vision | No alojada; modelo abierto | Solo cómputo |
| Anfibios/reptiles | **iNaturalist** (si hay acceso) | Vision (grupo) | No (de pago, negociado) | Negociado |
| Insectos/hongos | **iNaturalist** (si hay acceso) | Vision (grupo) | No | Negociado |
| Comodín/desconocido | **Google Vision** `LABEL_DETECTION` | — | **Sí** | 1k/mes gratis, luego $1.50/1k |

**Regla:** muestra **top-3 con confianza**, cruza contra la lista local, y deja
que el usuario **confirme**. Un juego de ciencia ciudadana gana con el paso
«¿es esta?», no fingiendo certeza.

---

## 3. Mejores prácticas (las que mueven la aguja)

1. **Sesgo local = la mejora más barata.** El geomodel de iNaturalist sube la
   precisión Top-1 de 75% → 87% con lat/lng. Tú tienes una ventaja aún mayor: tu
   universo de especies es **cerrado y conocido** (el inventario). Re-rankear los
   candidatos contra el inventario + la estación es un prior fortísimo y gratis.
2. **Multi-órgano para plantas.** Pl@ntNet acierta mucho más con hoja+flor+corteza
   de la misma planta. El asistente puede pedir «añade una foto de la flor».
3. **Llamada explícita y opt-in.** Solo llamar a la API al tocar «Identificar»,
   nunca en cada frame. Es el mayor ahorro de costo y latencia.
4. **Reducir la imagen en el cliente** (~1024px) antes de subir: menos costo,
   menos latencia.
5. **Caché por hash de imagen:** varios visitantes fotografían el mismo árbol
   señalizado → se responde de caché.
6. **Umbral de confianza + cola «necesita revisión»** para el admin. Protege la
   calidad del dato y alimenta el bucle de ciencia ciudadana.
7. **Consentimiento y privacidad:** aviso bilingüe antes de la 1ª subida («para
   identificar tu foto la enviamos a Pl@ntNet/Google…»). No guardar originales
   más de lo necesario. Coordenadas de especies sensibles ya se oscurecen.

### ⚠️ El riesgo #1 (referí hostil)
Re-rankear ciegamente contra el inventario produce **falsos positivos**: si un
visitante fotografía algo que **no está** en el inventario (una ornamental
escapada, una invasora, un error), el sistema devolverá con confianza la especie
*del inventario* más parecida — y eso **corrompe el dato**. Por eso «**no está en
el inventario / necesita revisión**» debe ser un **resultado de primera clase**,
no un caso borde. Esto además es la vía por la que el inventario *crece* con
hallazgos reales.

---

## 4. Plan por fases (converge con el objetivo de cuentas)

Cada fase deja algo funcionando; el backend de la Fase 1 es el mismo que habilita
login de visitante/admin y almacenamiento global.

**Fase 0 — ya hecho / ajuste inmediato (sin backend).**
El botón Pl@ntNet ya está codificado (necesita clave). *Pero* poner la clave en el
navegador es inseguro → sirve solo para prueba local, no para producción. No
publicar la clave. Esto fuerza la Fase 1.

**Fase 1 — Backend + proxy + plantas en producción (desbloquea también las cuentas).**
- Levantar **Supabase** (Auth + Postgres + Storage + Edge Functions).
- **Edge Function = proxy** que guarda la clave de Pl@ntNet del lado servidor;
  la PWA llama a *tu* endpoint, no a plantnet.org.
- Adjuntar coords de la reserva; **re-rankear contra el inventario**; devolver
  top-3 con confianza; ruta «necesita revisión».
- Migrar el inventario (`species.json`) y el contenido (`media.json`,
  `reserve_info.json`) a tablas de Supabase → **el admin edita en Studio** (panel
  tipo hoja de cálculo, sin programar). ← esto es el objetivo admin/parents.
- Cuentas de visitante (progreso guardado) con RLS. ← objetivo de almacenamiento global.
- Cron de GitHub Actions cada ~3 días para evitar la pausa por inactividad.

**Fase 2 — animales (grueso) + router on-device + aves.**
- **Google Vision** como fallback para animales (confirma el grupo) con tope de
  presupuesto duro.
- **Router on-device** (MobileNet/EfficientNet, TF.js/ONNX) para funcionar
  offline, elegir proveedor y filtrar fotos malas antes de gastar una llamada.
- **eBird** (clave gratis) → lista local de aves probables para el selector manual.

**Fase 3 — calidad iNaturalist + contribución real a GBIF.**
- **Escribir a iNaturalist** (help@inaturalist.org) describiendo la reserva, el
  juego no-comercial y el volumen, para negociar acceso al modelo de visión
  (techo de calidad en herps/insectos/mamíferos) y resolver la ambigüedad de ToS.
- Botón **«aportar a iNaturalist»**: publica una observación real bajo la cuenta
  del usuario → ID comunitaria → **GBIF/SiB Colombia**. Esto es lo que *de verdad*
  contribuye al registro global (llamar a su visión sola no aporta nada).

**Fase 4 — el modelo propio de la reserva (la ventaja que se compone).**
- Como el inventario es un **conjunto cerrado** (decenas–cientos de especies), un
  modelo pequeño (5–10MB) afinado con **las fotos que el propio juego recolecta**
  puede acertar mucho, offline, reservando las APIs para los casos dudosos.
- El juego genera sus propios datos de entrenamiento → cada temporada el modelo
  mejora. Ésta es la meta de largo plazo del «motor perfecto».

---

## 5. Costo y riesgo

- **Costo a tu escala (500–2.000 IDs/mes):** plantas **gratis** (Pl@ntNet);
  animales **~$1–2/mes** (Vision). Con tope de presupuesto, es un no-problema.
  Aplica a la **cuota educativa/sin ánimo de lucro** de Pl@ntNet como reserva.
- **Backend:** Supabase gratis alcanza; $25/mes Pro al crecer o si molesta la pausa.
- **Riesgos:** (1) falsos positivos por re-rank ciego → mitigado con «necesita
  revisión» de primera clase; (2) acceso a iNaturalist no garantizado → el plan no
  depende de él para plantas (el 60%+ del inventario es flora); (3) aves por foto
  sin solución de API → se asume sonido/lista local.

---

## 6. Decisiones que necesito de ti

1. **Backend: ¿Supabase?** Es mi recomendación (un backend para IA + cuentas +
   admin sin programar). Alternativa: Cloudflare (siempre despierto, pero el panel
   de admin lo construyo yo). → afecta también tu objetivo de login.
2. **Clave Pl@ntNet:** ¿creas la cuenta gratis en my.plantnet.org (500/día) y me
   pasas la clave para ponerla *en el proxy* (nunca en el navegador)?
3. **iNaturalist:** ¿quieres que redacte el correo para pedir acceso al modelo de
   visión (Fase 3)? Requiere una cuenta iNat de la reserva.
4. **Alcance inicial:** ¿arrancamos por **plantas en producción + cuentas**
   (Fase 1, el 60% del inventario y tu objetivo de login), y dejamos animales/iNat
   para después?
