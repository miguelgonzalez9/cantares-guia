// Cantares — guía instructiva dentro de la app (visitante + administración).
//
// Un solo motor: un TEMA es una lista de PASOS; un paso ilumina un elemento REAL
// de la pantalla (foco) o es una tarjeta de texto. No hay capturas de pantalla —
// envejecen con cada botón que se mueve; el foco siempre señala lo que hay.
//
// La guía NAVEGA (abre el panel, cambia de pestaña, enciende el modo edición)
// pero NUNCA guarda, borra ni sube nada. El usuario no practica dentro del tour:
// al terminar un tema la guía se cierra dejando la app EN el sitio del tema, que
// es el «ahí lo tienes» sin necesidad de un botón que lo diga.
//
// El contenido vive aquí, en el código, para que entre al service worker y
// funcione sin señal (la reserva no tiene cobertura en media finca).

let CTX = null;                // ver initGuide() al final para el contrato
let _pendingVisitor = false;   // el tour se pidió antes de que initGuide corriera
let _run = null;               // { steps, i, exitLabel, after, restore }
let _starting = false;         // un tema se está montando (ver startAdminTopic)

const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'es');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstRouteId = (c) => { const r = (c.state.routes || [])[0]; return r ? r.id : null; };

// ============================ CONTENIDO ============================

// ---- Tour del visitante. Bilingüe: lo lee quien llega por el QR de la entrada.
const VISITOR = {
  es: [
    { title: 'Los recorridos', anchor: '#route-bar',
      body: 'Cada recorrido es un camino con paradas. Tócalo aquí y el mapa te dibuja la ruta y hacia dónde va.',
      go: (c) => c.selectRoute(firstRouteId(c)) },
    { title: 'Activa tu ubicación', anchor: '#locate-btn',
      body: 'Con el GPS encendido te ves en el mapa y la app te avisa al llegar a cada parada, con su audio.',
      why: 'Sin ubicación el recorrido es solo un dibujo: no hay «estás aquí» ni avisos al llegar.',
      action: { label: '◎ Activar ahora', run: (c) => c.ensureGps() } },
    { title: 'El bosque, antes y ahora', anchor: '#bc-handle',
      body: 'Arrastra la línea para comparar la foto aérea de 2015 con la de hoy. Lo verde que aparece es bosque que volvió.' },
    { title: 'Qué es cada punto', anchor: '#legend-toggle',
      body: 'La leyenda dice qué significa cada color del mapa: miradores, agua, avistamientos, árboles.' },
    { title: 'Buscar sin dar vueltas', anchor: '#search-btn',
      body: 'Escribe el nombre de un punto o de una especie y el mapa te lleva.' },
    { title: 'El inventario de especies', anchor: '.tab[data-view="especies"]',
      body: 'Todo lo que vive en la reserva, con foto y ficha. Puedes filtrar por aves, árboles o flores.',
      go: (c) => c.switchView('especies') },
    { title: 'Nuestra historia', anchor: '.tab[data-view="restauracion"]',
      body: 'De dónde viene la reserva y cómo va la restauración del bosque, año por año.',
      go: (c) => c.switchView('restauracion') },
    { title: 'Aquí vuelves cuando quieras', anchor: '#help-btn',
      body: 'Este signo de interrogación abre esta guía otra vez. Buen camino.' },
  ],
  en: [
    { title: 'The routes', anchor: '#route-bar',
      body: 'Each route is a path with stops. Tap one here and the map draws the trail and which way it goes.',
      go: (c) => c.selectRoute(firstRouteId(c)) },
    { title: 'Turn on your location', anchor: '#locate-btn',
      body: 'With GPS on you can see yourself on the map, and the app speaks to you when you reach each stop.',
      why: 'Without location the route is only a drawing: no "you are here", no arrival prompts.',
      action: { label: '◎ Turn on now', run: (c) => c.ensureGps() } },
    { title: 'The forest, then and now', anchor: '#bc-handle',
      body: 'Drag the line to compare the 2015 aerial photo with the current one. The green that appears is forest that came back.' },
    { title: 'What each point means', anchor: '#legend-toggle',
      body: 'The legend explains every colour on the map: lookouts, water, wildlife spots, trees.' },
    { title: 'Find it without wandering', anchor: '#search-btn',
      body: 'Type the name of a point or a species and the map takes you there.' },
    { title: 'The species inventory', anchor: '.tab[data-view="especies"]',
      body: 'Everything living in the reserve, with photos. Filter by birds, trees or flowers.',
      go: (c) => c.switchView('especies') },
    { title: 'Our story', anchor: '.tab[data-view="restauracion"]',
      body: 'Where the reserve comes from and how the forest restoration is going, year by year.',
      go: (c) => c.switchView('restauracion') },
    { title: 'Come back any time', anchor: '#help-btn',
      body: 'This question mark opens the guide again. Enjoy the walk.' },
  ],
};

// ---- Guía de administración (solo español: sus únicos lectores lo hablan).
// `panel` + `tab` dejan la app como el tema la necesita ANTES del primer paso.
// En el teléfono el panel solo deja ver el mapa en modo hoja (.as-sheet, que
// activa el modo edición): un tema que hable del mapa tiene que pedir 'sheet'.
const ADMIN = [
  { id: 'punto', emoji: '📍', title: 'Añadir y editar un punto', block: 'start', panel: 'sheet', tab: 'puntos',
    steps: [
      { title: 'Tu botón de siempre', anchor: '#admin-fab',
        body: 'La llave inglesa abre la administración y enciende el modo edición de una vez.' },
      { title: 'Editando: sí o no', anchor: '#admin-edit',
        body: 'En amarillo, el mapa te obedece: tocas y seleccionas. Apágalo y vuelves a ver la app como la ve un visitante.' },
      { title: 'Crear el punto', anchor: '.edit-new[data-new="punto"]',
        body: 'Toca aquí y después toca el mapa en el sitio exacto. El punto nace ahí.' },
      { title: 'Contar qué es', anchor: '#pt-add',
        body: 'Cada punto lleva nombre, tipo (mirador, agua, árbol…), foto y descripción en español e inglés.',
        why: 'El tipo decide su color en el mapa y el icono de la leyenda.' },
      { title: 'Si no hay señal, no pasa nada', anchor: '#admin-fab',
        body: 'Cuando veas «💾 se subirá con señal», el cambio ya está guardado en el teléfono y sube solo al volver el internet.',
        why: 'No cierres sesión con cambios pendientes: la cola vive en tu sesión.' },
    ] },
  { id: 'fotos', emoji: '🖼️', title: 'Clasificar fotos', block: 'start', panel: 'full', tab: 'fotos',
    steps: [
      { title: 'La bandeja', anchor: '.admin-tab[data-t="fotos"]', wait: '#fm-add',
        body: 'Aquí llegan las fotos que todavía no son de nadie. El número de la pestaña es cuántas esperan.' },
      { title: 'Decir de qué es', anchor: '.fm-card [data-a="assign"]',
        body: 'Toca «Clasificar» y elige un punto o una especie. Si tocas la miniatura la ves grande antes de decidir.' },
      { title: 'Cuando no sabes cuál es', anchor: '.fm-card [data-a="assign"]',
        body: 'Filtra por una subcategoría y elige el primer renglón, «🏷️ Todo el grupo»: la foto queda como «un ave» sin inventar la especie.',
        why: 'Antes sin clasificar que mal clasificado: una especie inventada ensucia el inventario.' },
      { title: 'Portada y pie', anchor: '.fm-card [data-a="assign"]',
        body: 'La ★ decide qué foto se ve primero en la ficha de ese punto o especie; el ✎ le pone pie.' },
      { title: 'Traer del archivo', anchor: '#fm-add',
        body: 'Puedes subir desde el teléfono o traer una tanda del archivo de Dropbox sin bajarlo entero.' },
    ] },
  { id: 'guiones', emoji: '🎙️', title: 'Los guiones de un recorrido', block: 'start', panel: 'sheet', tab: 'recorridos',
    steps: [
      { title: 'Qué es un recorrido', anchor: '.admin-tab[data-t="recorridos"]', wait: '#rt-add',
        body: 'Una lista de senderos EN ORDEN, con un punto de inicio y uno de fin.' },
      { title: 'Armarlo en el mapa', anchor: '#rt-add',
        body: 'Dentro del recorrido, «🗺️ Elegir senderos» te deja tocarlos en el mapa; «🧭 Ordenar inicio → fin» los encadena solos.' },
      { title: 'El orden manda', anchor: '#rt-add',
        body: 'Arrastra ⠿ para cambiar el orden. ⧉ repite un sendero: así se vuelve por donde viniste.' },
      { title: 'La audioguía', anchor: '#rt-add',
        body: 'Escribe un guión para cada punto del recorrido: al llegar, el teléfono lo lee en voz alta.',
        why: 'El guión es por recorrido — el mismo punto puede contar otra cosa en otra ruta.' },
    ] },
  { id: 'senderos', emoji: '🥾', title: 'Senderos: dibujar y grabar caminando', block: 'later', panel: 'sheet', tab: 'senderos',
    steps: [
      { title: 'Dos formas', anchor: '.admin-tab[data-t="senderos"]', wait: '#tr-add',
        body: 'Puedes dibujar el sendero tocando el mapa, o grabarlo con el GPS mientras lo caminas.' },
      { title: 'Grabar caminando', anchor: '#tr-add',
        body: 'Crea el sendero, elige grabar y camina con la pantalla encendida. Al terminar, guardas.',
        why: 'Si la pantalla se apaga el GPS se corta y el sendero queda a medias.' },
      { title: 'Retocar', anchor: '#tr-add',
        body: 'Arrastra los vértices para corregir. Si sueltas uno junto a otro sendero se enganchan y la red queda conectada.' },
      { title: 'Cortar y extender', anchor: '#tr-add',
        body: '✂️ parte un sendero en dos donde toques; ➕ lo alarga por un extremo.' },
    ] },
  { id: 'circuito', emoji: '📦', title: 'De dónde salen las fotos', block: 'later', panel: 'closed',
    steps: [
      { title: 'Ustedes solo sueltan las fotos', card: true,
        body: 'Todas las fotos, sin ordenar, van a la carpeta Cantares/fotos en Dropbox. Nada más.' },
      { title: 'El domingo se ordenan solas', card: true,
        body: 'Cada semana el computador las revisa: borra repetidas, reconoce especies y las guarda en su carpeta.' },
      { title: 'Lo dudoso se queda quieto', card: true,
        body: 'Si no está seguro, deja la foto sin clasificar a propósito.',
        why: 'Preferimos una foto sin nombre a una foto con el nombre equivocado.' },
      { title: 'Y de ahí a la app', card: true,
        body: 'Lo que ves en la bandeja de 🖼️ Fotos es el resultado de esa pasada. Tu trabajo es confirmar y elegir portadas.' },
    ] },
  { id: 'especies', emoji: '🦋', title: 'El inventario de especies', block: 'later', panel: 'closed',
    steps: [
      { title: 'Viven en su pestaña', anchor: '.tab[data-view="especies"]',
        body: 'Las especies no se editan en el panel de administración, sino aquí.',
        go: (c) => c.switchView('especies') },
      { title: 'Nueva especie', anchor: '#species-admin-add',
        body: 'Nombre común, científico, grupo y foto. El grupo decide en qué filtro aparece.' },
    ] },
  { id: 'textos', emoji: '✍️', title: 'Los textos de la app', block: 'later', panel: 'closed',
    steps: [
      { title: 'Nuestra historia', anchor: '#hist-edit',
        body: 'Este lápiz abre el editor de la historia y de su línea de tiempo.',
        go: (c) => c.switchView('restauracion') },
      { title: 'Servicios y visita', anchor: '#cm-edit',
        body: 'En la pestaña Info editas servicios, tarifas y reseñas; más abajo, horarios y cómo llegar.',
        go: (c) => c.switchView('info') },
    ] },
];

// ============================ MOTOR ============================

function ovEl() {
  let ov = document.getElementById('gd-ov');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'gd-ov'; ov.className = 'gd-ov';
    ov.innerHTML = '<div class="gd-hole" id="gd-hole"></div><div class="gd-bubble" id="gd-bubble"></div>';
    document.body.appendChild(ov);
  }
  return ov;
}

// Espera a que exista un selector tras un re-render (renderPanel() reconstruye
// el DOM entero). Corto a propósito: si no aparece, el paso cae a tarjeta y
// sigue enseñando, en vez de dejar la pantalla en negro.
function waitFor(sel, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const el = sel ? document.querySelector(sel) : null;
      if (el || Date.now() - t0 > ms) return resolve(el);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

// ¿Se puede señalar? Un elemento sin caja (oculto, tapado por el panel a pantalla
// completa o fuera de la ventana) no se ilumina: para eso está la tarjeta.
function usableRect(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null;
  return r;
}

async function renderStep() {
  if (!_run) return;
  const st = _run.steps[_run.i];
  const ov = ovEl(), hole = ov.querySelector('#gd-hole'), bub = ov.querySelector('#gd-bubble');
  if (!_run.painted) {
    try { if (st.go) await st.go(CTX); } catch (e) { console.warn('[guide] go', e && e.message); }
    if (st.wait) await waitFor(st.wait, 700);
  }
  const el = st.card ? null : await waitFor(st.anchor, _run.painted ? 0 : 400);
  const rect = usableRect(el);
  const n = _run.steps.length, last = _run.i === n - 1;
  const es = lang() !== 'en';

  bub.innerHTML = `
    <div class="gd-h"><b>${esc(st.title)}</b><span class="gd-n">${_run.i + 1}/${n}</span></div>
    <p class="gd-b">${esc(st.body)}</p>
    ${st.why ? `<p class="gd-why">${esc(st.why)}</p>` : ''}
    ${st.action ? `<button class="gd-act" id="gd-act">${esc(st.action.label)}</button>` : ''}
    <div class="gd-btns">
      <button class="gd-x" id="gd-x">${esc(_run.exitLabel)}</button>
      <span class="gd-sp"></span>
      ${_run.i ? `<button class="gd-prev" id="gd-prev">${es ? 'Atrás' : 'Back'}</button>` : ''}
      <button class="gd-next" id="gd-next">${last ? (es ? 'Listo' : 'Done') : (es ? 'Siguiente' : 'Next')}</button>
    </div>`;

  if (rect) {
    const pad = 8;
    hole.style.display = 'block';
    hole.style.left = `${rect.left - pad}px`; hole.style.top = `${rect.top - pad}px`;
    hole.style.width = `${rect.width + pad * 2}px`; hole.style.height = `${rect.height + pad * 2}px`;
    bub.classList.remove('gd-card');
    // Debajo del ancla si cabe; si no, encima. Y siempre dentro de la ventana.
    const bw = Math.min(340, window.innerWidth - 24);
    bub.style.width = `${bw}px`;
    const bh = bub.offsetHeight || 190;
    const below = rect.bottom + 12 + bh < window.innerHeight;
    bub.style.top = `${below ? rect.bottom + 12 : Math.max(12, rect.top - 12 - bh)}px`;
    bub.style.left = `${Math.min(Math.max(12, rect.left + rect.width / 2 - bw / 2), window.innerWidth - bw - 12)}px`;
  } else {
    hole.style.display = 'none';
    bub.classList.add('gd-card');
    bub.style.cssText = '';
  }
  _run.painted = true;

  const act = bub.querySelector('#gd-act');
  if (act) act.onclick = () => {
    try { st.action.run(CTX); } catch (e) { console.warn('[guide] action', e && e.message); }
    act.disabled = true; act.textContent = '✓';
  };
  bub.querySelector('#gd-x').onclick = () => closeGuide();
  const prev = bub.querySelector('#gd-prev');
  if (prev) prev.onclick = () => { _run.i--; _run.painted = false; renderStep(); };
  bub.querySelector('#gd-next').onclick = () => {
    if (_run.i < n - 1) { _run.i++; _run.painted = false; renderStep(); } else finishTopic();
  };
}

// Reanclar sin re-ejecutar `go()`: si se recalculara el paso entero, girar el
// teléfono volvería a abrir paneles y a cambiar de pestaña.
let _reanchor = null;
function watchLayout(on) {
  if (on && !_reanchor) {
    _reanchor = () => { if (_run) renderStep(); };
    window.addEventListener('resize', _reanchor);
    window.addEventListener('scroll', _reanchor, true);
  } else if (!on && _reanchor) {
    window.removeEventListener('resize', _reanchor);
    window.removeEventListener('scroll', _reanchor, true);
    _reanchor = null;
  }
}

function startTopic(steps, { exitLabel, after = null, restore = null } = {}) {
  _run = { steps, i: 0, painted: false, exitLabel: exitLabel || (lang() === 'en' ? '✕ Close' : '✕ Cerrar'), after, restore };
  ovEl().classList.add('open');
  if (CTX && CTX.pushBack) CTX.pushBack('guide', () => closeGuide(true));
  watchLayout(true);
  renderStep();
}

function finishTopic() {
  const after = _run && _run.after;
  closeGuide();                  // cerrar deja la app EN el sitio del tema
  if (after) after();
}

function closeGuide(fromBack) {
  if (!_run) { const o = document.getElementById('gd-ov'); if (o) o.classList.remove('open'); return; }
  const restore = _run.restore;
  _run = null;
  watchLayout(false);
  const ov = document.getElementById('gd-ov'); if (ov) ov.classList.remove('open');
  if (!fromBack && CTX && CTX.popBack) CTX.popBack('guide');
  if (restore) { try { restore(); } catch (e) { console.warn('[guide] restore', e && e.message); } }
}

// ---- índice ----
export function openGuideIndex() {
  closeGuide();
  const en = lang() === 'en';
  const groups = [{ label: '', rows: [{ emoji: '🗺️', label: en ? 'The app, as a visitor sees it' : 'La app, como la ve un visitante', run: () => startVisitor() }] }];
  if (document.body.classList.contains('is-admin')) {
    const block = (b) => ADMIN.filter((t) => t.block === b).map((t) => ({ emoji: t.emoji, label: t.title, run: () => startAdminTopic(t) }));
    groups.push({ label: 'Empieza aquí', rows: block('start') });
    groups.push({ label: 'Cuando lo necesites', rows: block('later') });
  }
  const ov = ovEl(), bub = ov.querySelector('#gd-bubble');
  ov.classList.add('open');
  if (CTX && CTX.pushBack) CTX.pushBack('guide', () => ov.classList.remove('open'));
  ov.querySelector('#gd-hole').style.display = 'none';
  bub.classList.add('gd-card'); bub.style.cssText = '';
  bub.innerHTML = `<div class="gd-h"><b>${en ? 'Help' : 'Ayuda'}</b></div>
    ${groups.map((g, gi) => `<div class="gd-grp">${g.label ? `<div class="gd-grp-h">${esc(g.label)}</div>` : ''}
      ${g.rows.map((r, ri) => `<button class="gd-item" data-g="${gi}" data-i="${ri}"><span>${r.emoji}</span> ${esc(r.label)}</button>`).join('')}</div>`).join('')}
    <div class="gd-btns"><span class="gd-sp"></span><button class="gd-x" id="gd-x">${en ? 'Close' : 'Cerrar'}</button></div>`;
  bub.querySelector('#gd-x').onclick = () => { ov.classList.remove('open'); if (CTX && CTX.popBack) CTX.popBack('guide'); };
  bub.querySelectorAll('.gd-item').forEach((b) => b.onclick = () => groups[+b.dataset.g].rows[+b.dataset.i].run());
}

// ---- tour del visitante ----
function startVisitor() {
  const prevRoute = CTX && CTX.state ? CTX.state.activeRoute : null;
  const prevView = CTX && CTX.currentView ? CTX.currentView() : 'recorridos';
  startTopic(VISITOR[lang()], {
    exitLabel: lang() === 'en' ? '✕ Skip' : '✕ Cerrar',
    // El tour cambió de pestaña y encendió un recorrido de ejemplo. Devolverlo es
    // estado de VISTA, no datos: no hay nada que deshacer en la nube.
    restore: () => {
      try { CTX.switchView(prevView); } catch (e) { /* vista ausente */ }
      try { if (CTX.state.activeRoute !== prevRoute) CTX.selectRoute(prevRoute); } catch (e) { /* mapa aún cargando */ }
    },
  });
}

// Se llama desde el «Empezar» del onboarding. Una sola vez en la vida: si lo
// cierran a mitad no vuelve a salir solo — para eso queda el ? del header.
export function startVisitorTourOnce() {
  if (localStorage.getItem('cantares_guide_seen')) return;
  localStorage.setItem('cantares_guide_seen', '1');
  if (!CTX) { _pendingVisitor = true; return; }
  startVisitor();
}

// ---- temas de admin ----
async function applyPanel(topic) {
  if (!CTX || !CTX.openAdminAt) return;
  if (topic.panel === 'closed') { if (CTX.closeAdmin) CTX.closeAdmin(); return; }
  await CTX.openAdminAt(topic.tab, { edit: topic.panel === 'sheet' });
}
function startAdminTopic(topic, rest = []) {
  // applyPanel abre el panel, y abrir el panel dispara maybeStartAdminGuide: sin
  // esta bandera, elegir un tema del índice en una instalación nueva lanzaría
  // ADEMÁS la serie de bienvenida encima.
  _starting = true;
  applyPanel(topic).then(() => {
    _starting = false;
    startTopic(topic.steps, {
      exitLabel: rest.length ? '✕ Dejarlo para luego' : '✕ Cerrar',
      after: rest.length ? () => startAdminTopic(rest[0], rest.slice(1)) : null,
    });
  });
}

// La primera vez que se abre el panel: los 3 temas de «Empieza aquí», seguidos,
// con la salida siempre a la vista.
export function maybeStartAdminGuide() {
  if (!CTX || _run || _starting || localStorage.getItem('cantares_guide_admin_seen')) return;
  localStorage.setItem('cantares_guide_admin_seen', '1');
  const start = ADMIN.filter((t) => t.block === 'start');
  if (start.length) setTimeout(() => startAdminTopic(start[0], start.slice(1)), 400);
}

// ctx: { state, switchView, currentView, pushBack, popBack, selectRoute, ensureGps,
//        openAdminAt, closeAdmin }
export function initGuide(ctx) {
  CTX = ctx;
  const btn = document.getElementById('help-btn');
  if (btn) btn.onclick = () => openGuideIndex();
  if (_pendingVisitor) { _pendingVisitor = false; startVisitor(); }
}

// Para las pruebas: el contenido sin el DOM.
export const _TOPICS = { visitor: VISITOR, admin: ADMIN };
