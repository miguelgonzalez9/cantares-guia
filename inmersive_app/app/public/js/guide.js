// Cantares — guía instructiva dentro de la app (visitante + administración).
//
// Un ÁRBOL, no una lista: cada tema es una secuencia de pasos, y un paso puede
// abrir una RAMA (un sub-tutorial propio) y volver al mismo nodo al terminar.
// Un paso ilumina un elemento real de la pantalla o cae a tarjeta si no lo
// encuentra. No hay capturas: envejecen con cada botón que se mueve.
//
// La guía NAVEGA (abre el panel, cambia de pestaña, abre una ficha) pero NUNCA
// guarda, borra ni sube nada. Y manda en la pantalla: antes de cada paso
// despeja las cajas de la app, porque cualquiera de ellas tapaba el paso
// siguiente. El paso que necesita una caja abierta la abre en su propio `go`.
//
// El contenido vive aquí, en el código, para que entre al service worker y
// funcione sin señal (la reserva no tiene cobertura en media finca).

let CTX = null;                // ver initGuide() al final para el contrato
let _pendingVisitor = false;   // el tour se pidió antes de que initGuide corriera
let _run = null;               // { steps, i, exitLabel, after, restore, topic }
let _stack = [];               // nodos padre mientras se recorre una rama
let _starting = false;         // un tema se está montando (ver startAdminTopic)
let _stage = null;             // estado del panel ya aplicado ('sheet:puntos'…)
let _shown = false;            // el tour del visitante ya salió en esta carga

const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'es');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstRouteId = (c) => { const r = (c.state.routes || [])[0]; return r ? r.id : null; };
const isGuest = () => localStorage.getItem('cantares_guest') === '1';
const click = (sel) => { const el = document.querySelector(sel); if (el) el.click(); };

// ============================ CONTENIDO ============================

// ---- Ramas del visitante ---------------------------------------------------

// La ficha de un recorrido: lo que trae y cómo se empieza.
const SUB_FICHA = {
  es: [
    { title: 'La ficha del recorrido', anchor: '#route-info',
      go: (c) => c.selectRoute(firstRouteId(c)),
      body: 'Al tocar un recorrido se abre su ficha: nombre, resumen, la distancia (📏), lo que se sube en total (⛰️) y el tiempo aproximado a pie (⏱️).' },
    { title: 'Las paradas, en orden', anchor: '.ri-points', keep: true,
      body: 'La lista va en el orden en que te las vas encontrando. Toca una y el mapa te la muestra.' },
    { title: 'Empezar el recorrido', anchor: '#ri-start', keep: true,
      body: 'Este botón arranca la guía. Te pregunta si prefieres escucharla o leerla, y desde ahí la app te acompaña parada por parada.',
      why: 'Necesita la ubicación encendida: es lo que le dice cuándo llegaste a cada parada.' },
  ],
  en: [
    { title: 'The route card', anchor: '#route-info',
      go: (c) => c.selectRoute(firstRouteId(c)),
      body: 'Tapping a route opens its card: name, summary, distance (📏), total climb (⛰️) and the approximate walking time (⏱️).' },
    { title: 'The stops, in order', anchor: '.ri-points', keep: true,
      body: 'The list follows the order you meet them. Tap one and the map shows it to you.' },
    { title: 'Starting the route', anchor: '#ri-start', keep: true,
      body: 'This button starts the guide. It asks whether you prefer to listen or read, and from there the app walks you stop by stop.',
      why: 'It needs location on: that is what tells it when you reached each stop.' },
  ],
};

// El inventario de especies.
const SUB_ESPECIES = {
  es: [
    { title: 'Filtrar por grupo', anchor: '#species-filters',
      go: (c) => c.switchView('especies'),
      body: 'Aves, árboles, flores, mamíferos… En algunos grupos aparece además un interruptor entre las especies ya vistas y las que se esperan en la zona.' },
    { title: 'Cada tarjeta es una ficha', anchor: '#species-grid',
      body: 'Tócala y verás la foto grande, el nombre científico y en qué puntos de la reserva se ha registrado.' },
  ],
  en: [
    { title: 'Filter by group', anchor: '#species-filters',
      go: (c) => c.switchView('especies'),
      body: 'Birds, trees, flowers, mammals… Some groups also show a switch between species already seen and those expected in the area.' },
    { title: 'Every card is a profile', anchor: '#species-grid',
      body: 'Tap it for the big photo, the scientific name and where in the reserve it has been recorded.' },
  ],
};

// ---- Tour del visitante EN LA RESERVA -------------------------------------
const VISITOR = {
  es: [
    { title: 'Los recorridos', anchor: '#route-bar',
      body: 'Cada recorrido es un camino con paradas. Toca uno y el mapa te dibuja la ruta.',
      branches: [{ label: '👀 Ver cómo es un recorrido', steps: SUB_FICHA.es }] },
    { title: 'Activa tu ubicación', anchor: '#locate-btn',
      body: 'Con el GPS encendido te ves en el mapa y la app te avisa al llegar a cada parada.',
      why: 'Sin ubicación el recorrido es solo un dibujo: no hay «estás aquí» ni avisos.',
      action: { label: '◎ Activar ahora', run: (c) => c.ensureGps() } },
    { title: 'El bosque, antes y ahora', anchor: '#bc-handle',
      body: 'A la derecha de la línea ves la imagen del bosque en 2024 y a la izquierda la de 2015. Desliza el slider para ver el cambio.' },
    { title: 'Qué es cada punto', anchor: '#legend', go: (c) => c.openLegend(),
      body: 'La leyenda lista los tipos de punto con su color: miradores, agua, avistamientos, árboles. Tócalos para esconder o mostrar cada tipo en el mapa.' },
    { title: 'Buscar sin dar vueltas', anchor: '#search-btn',
      body: 'Escribe el nombre de un punto o de una especie y el mapa te lleva.' },
    { title: 'El inventario de especies', anchor: '.tab[data-view="especies"]',
      body: 'Todo lo que vive en la reserva, con foto y ficha.',
      branches: [{ label: '🦋 Ver cómo se usa', steps: SUB_ESPECIES.es }] },
    { title: 'Nuestra historia', anchor: '.tab[data-view="restauracion"]',
      body: 'De dónde viene la reserva y cómo va la restauración del bosque, año por año.',
      go: (c) => c.switchView('restauracion') },
    { title: 'Reservar y cómo llegar', anchor: '.cm-links',
      body: 'En la pestaña Info están los servicios y tarifas, el enlace de Airbnb y el WhatsApp; más abajo, los horarios y cómo llegar.',
      go: (c) => c.switchView('info') },
    { title: 'Aquí vuelves cuando quieras', anchor: '#help-btn',
      body: 'Este signo de interrogación abre esta guía otra vez. Buen camino.',
      go: (c) => c.switchView('recorridos') },
  ],
  en: [
    { title: 'The routes', anchor: '#route-bar',
      body: 'Each route is a path with stops. Tap one and the map draws the trail.',
      branches: [{ label: '👀 See what a route looks like', steps: SUB_FICHA.en }] },
    { title: 'Turn on your location', anchor: '#locate-btn',
      body: 'With GPS on you can see yourself on the map and the app tells you when you reach each stop.',
      why: 'Without location the route is only a drawing: no "you are here", no arrival prompts.',
      action: { label: '◎ Turn on now', run: (c) => c.ensureGps() } },
    { title: 'The forest, then and now', anchor: '#bc-handle',
      body: 'To the right of the line you see the forest in 2024, and to the left the one from 2015. Slide it to see the change.' },
    { title: 'What each point means', anchor: '#legend', go: (c) => c.openLegend(),
      body: 'The legend lists the point types with their colour: lookouts, water, wildlife, trees. Tap them to hide or show each type on the map.' },
    { title: 'Find it without wandering', anchor: '#search-btn',
      body: 'Type the name of a point or a species and the map takes you there.' },
    { title: 'The species inventory', anchor: '.tab[data-view="especies"]',
      body: 'Everything living in the reserve, with photos.',
      branches: [{ label: '🦋 See how it works', steps: SUB_ESPECIES.en }] },
    { title: 'Our story', anchor: '.tab[data-view="restauracion"]',
      body: 'Where the reserve comes from and how the forest restoration is going, year by year.',
      go: (c) => c.switchView('restauracion') },
    { title: 'Booking and getting here', anchor: '.cm-links',
      body: 'The Info tab has services and rates, the Airbnb link and WhatsApp; further down, opening hours and directions.',
      go: (c) => c.switchView('info') },
    { title: 'Come back any time', anchor: '#help-btn',
      body: 'This question mark opens the guide again. Enjoy the walk.',
      go: (c) => c.switchView('recorridos') },
  ],
};

// ---- Tour del INVITADO (no está en la reserva) ----------------------------
// Sale cada vez que alguien entra sin cuenta. Más corto a propósito: desde su
// casa no puede caminar un sendero, y enseñarle la audioguía sería vender humo.
const GUEST = {
  es: [
    { title: 'Bienvenido a Cantares', card: true,
      body: 'Estás viendo la reserva desde fuera. Puedes recorrer el mapa, ver cómo ha vuelto el bosque y conocer sus especies; la guía por senderos se enciende cuando vengas.' },
    { title: 'El bosque, antes y ahora', anchor: '#bc-handle',
      body: 'A la derecha de la línea ves la imagen del bosque en 2024 y a la izquierda la de 2015. Desliza el slider para ver el cambio.' },
    { title: 'Los puntos del mapa', anchor: '#legend', go: (c) => c.openLegend(),
      body: 'Miradores, quebradas, árboles y sitios de avistamiento. Toca cualquiera en el mapa para ver su ficha con foto.' },
    { title: 'El inventario de especies', anchor: '.tab[data-view="especies"]',
      body: 'Todo lo que vive en la reserva, con foto y ficha.',
      branches: [{ label: '🦋 Ver cómo se usa', steps: SUB_ESPECIES.es }] },
    { title: 'Nuestra historia', anchor: '.tab[data-view="restauracion"]',
      body: 'De dónde viene la reserva y cómo va la restauración: de potrero a bosque, año por año.',
      go: (c) => c.switchView('restauracion') },
    { title: 'Cuando vengas', anchor: '#route-bar',
      body: 'En la reserva, con la ubicación encendida, esta barra abre los recorridos guiados: la app te acompaña parada por parada y te cuenta cada una.',
      go: (c) => c.switchView('recorridos') },
    { title: 'Reservar y cómo llegar', anchor: '.cm-links',
      body: 'Servicios y tarifas, el enlace de Airbnb y el WhatsApp; más abajo, horarios y cómo llegar.',
      go: (c) => c.switchView('info') },
    { title: 'Aquí vuelves cuando quieras', anchor: '#help-btn',
      body: 'Este signo de interrogación abre esta guía otra vez.',
      go: (c) => c.switchView('recorridos') },
  ],
  en: [
    { title: 'Welcome to Cantares', card: true,
      body: 'You are seeing the reserve from afar. You can explore the map, see how the forest came back and meet its species; the trail guide switches on when you visit.' },
    { title: 'The forest, then and now', anchor: '#bc-handle',
      body: 'To the right of the line you see the forest in 2024, and to the left the one from 2015. Slide it to see the change.' },
    { title: 'The points on the map', anchor: '#legend', go: (c) => c.openLegend(),
      body: 'Lookouts, streams, trees and wildlife spots. Tap any of them on the map for its profile and photo.' },
    { title: 'The species inventory', anchor: '.tab[data-view="especies"]',
      body: 'Everything living in the reserve, with photos.',
      branches: [{ label: '🦋 See how it works', steps: SUB_ESPECIES.en }] },
    { title: 'Our story', anchor: '.tab[data-view="restauracion"]',
      body: 'Where the reserve comes from and how the restoration is going: from pasture to forest, year by year.',
      go: (c) => c.switchView('restauracion') },
    { title: 'When you visit', anchor: '#route-bar',
      body: 'At the reserve, with location on, this bar opens the guided routes: the app walks you stop by stop and tells you about each one.',
      go: (c) => c.switchView('recorridos') },
    { title: 'Booking and getting here', anchor: '.cm-links',
      body: 'Services and rates, the Airbnb link and WhatsApp; further down, opening hours and directions.',
      go: (c) => c.switchView('info') },
    { title: 'Come back any time', anchor: '#help-btn',
      body: 'This question mark opens the guide again.',
      go: (c) => c.switchView('recorridos') },
  ],
};

// ---- Guía de administración (solo español: sus únicos lectores lo hablan).
// `panel` + `tab` dejan la app como el paso la necesita, y pueden declararse por
// PASO: en el teléfono el panel tapa la pantalla completa cuando el modo edición
// está apagado, así que el paso que señala un botón de fuera pide 'closed'.

const SUB_FICHA_PUNTO = [
  { title: 'Nombre del punto', anchor: '#f-title', go: () => click('#pt-add'),
    body: 'El título en español y, debajo, el mismo en inglés. Es lo que se lee en el mapa.' },
  { title: 'La descripción', anchor: '#f-desc',
    body: 'Lo que quieras contar de ese sitio. Con descripción, foto o especies el punto muestra el botón «Más información»; sin nada de eso, solo el título.' },
  { title: 'El tipo', anchor: '#f-tipo',
    body: 'Mirador, agua, avistamiento, árbol… El tipo decide el color y el ícono del pin, y su casilla en la leyenda.' },
  { title: 'A qué recorridos pertenece', anchor: '#f-routes',
    body: 'Marca los recorridos que pasan por aquí. Eso es lo que mete el punto en la lista de paradas de cada uno.' },
  { title: 'Las especies del punto', anchor: '#f-sp-list',
    body: 'Busca y marca lo que se ve ahí. Aparecerán en la ficha del punto, y el punto en la de cada especie.' },
  { title: 'La foto', anchor: '#f-photo-prev',
    body: 'Puedes tomarla en el momento o elegirla del teléfono. Para árboles hay además una foto de la hoja.' },
  { title: 'Dónde está', anchor: '#f-loc',
    body: '«📡 Mi ubicación» lo pone donde estás parado — lo normal si lo creas en campo. «📍 En el mapa» te deja tocarlo.' },
  { title: 'Guardar', anchor: '.admin-save',
    body: 'Al guardar, el punto aparece en el mapa para todo el mundo.',
    why: 'Sin señal verás «💾 se subirá con señal»: está guardado en el teléfono y sube solo cuando vuelva el internet.' },
];

const SUB_TRAZAR = [
  { title: 'Nombre del sendero', anchor: '#tr-name', go: () => click('#tr-add'),
    body: 'Ponle un nombre que reconozcas después: «Camino del río», «Subida al mirador».' },
  { title: 'Dibujarlo tocando', anchor: '#tr-draw',
    body: 'Vas tocando el mapa punto por punto y la línea se va formando. Sirve para pasar a limpio un camino que ya conoces.' },
  { title: 'O grabarlo caminando', anchor: '#tr-gps',
    body: 'Enciende y camina el sendero con el teléfono encima: el GPS lo va trazando solo.',
    why: 'Deja la pantalla encendida — si se apaga, el GPS se corta y el sendero queda a medias.' },
  { title: 'Corregir después', anchor: '#tr-geo',
    body: 'Con el sendero ya trazado aparece «✎ Editar vértices»: arrastras los puntos para ajustarlo, y si sueltas uno junto a otro sendero se enganchan y la red queda conectada.' },
];

const SUB_ARMAR_RECORRIDO = [
  { title: 'Nombre y color', anchor: '#rt-name', go: () => click('#rt-add'),
    body: 'El nombre y el color con el que se pinta en el mapa. El emoji es el que verá el visitante en la barra de recorridos.' },
  { title: 'Elegir los senderos', anchor: '#rt-pick',
    body: 'Tocas los senderos en el mapa y se van añadiendo. «🧭 Ordenar inicio → fin» los encadena solos.' },
  { title: 'El orden manda', anchor: '#rt-segs',
    body: 'Arrastra ⠿ para cambiar el orden, y ⧉ para repetir un sendero: así se vuelve por donde viniste.',
    why: 'El orden define la dirección: el primero debe salir del punto de inicio y el último llegar al de fin.' },
  { title: 'Dónde empieza y dónde termina', anchor: '#rt-start-pick',
    body: 'Marca el punto de inicio y el de fin tocándolos en el mapa. Con eso la app sabe orientar el recorrido.' },
  { title: 'Las paradas', anchor: '#rt-mem-pick',
    body: 'Toca en el mapa los puntos que son parada de este recorrido. Salen en la ficha en el orden en que se caminan.' },
  { title: 'Los guiones (audioguía)', anchor: '#rt-scripts',
    body: 'Escribe qué contar en cada parada. Al llegar, el teléfono lo lee en voz alta.',
    why: 'El guión es de este recorrido: la misma parada puede contar otra cosa en otro.' },
];

const ADMIN = [
  { id: 'puntos', emoji: '📍', title: 'Puntos del mapa', block: 'start', panel: 'sheet', tab: 'puntos',
    steps: [
      { title: 'Tu botón de siempre', anchor: '#admin-fab', panel: 'closed',
        body: 'La llave inglesa abre la administración. Está siempre en la pantalla del mapa.' },
      { title: 'Editando: sí o no', anchor: '#admin-edit',
        body: 'En amarillo, el mapa te obedece: tocas un punto o un sendero y queda seleccionado para editarlo. Apagado, ves la app como la ve un visitante.' },
      { title: 'Crear un punto', anchor: '#pt-add',
        body: 'Desde aquí nace un punto nuevo.',
        branches: [{ label: '📝 Ver cómo se llena la ficha', steps: SUB_FICHA_PUNTO }] },
      { title: 'La lista de puntos', anchor: '.admin-list',
        body: 'Todos los puntos de la reserva. Tocas uno y el mapa vuela hasta él; «Editar» abre la misma ficha.' },
    ] },
  { id: 'senderos', emoji: '🥾', title: 'Senderos', block: 'start', panel: 'sheet', tab: 'senderos',
    steps: [
      { title: 'Qué es un sendero', anchor: '.admin-tab[data-t="senderos"]', wait: '#tr-add',
        body: 'La línea del camino, sin más. Son la base: los recorridos se arman encadenando senderos.' },
      { title: 'Crear un sendero', anchor: '#tr-add',
        body: 'Dos formas de trazarlo: dibujándolo en el mapa o caminándolo con el GPS.',
        branches: [{ label: '✏️ Ver cómo se traza', steps: SUB_TRAZAR }] },
      { title: 'Cortar y extender', anchor: '.admin-list',
        body: 'Con un sendero seleccionado en el mapa aparecen ✂️ (partirlo en dos donde toques) y ➕ (alargarlo por un extremo).' },
    ] },
  { id: 'recorridos', emoji: '🧭', title: 'Recorridos y audioguía', block: 'start', panel: 'sheet', tab: 'recorridos',
    steps: [
      { title: 'Qué es un recorrido', anchor: '.admin-tab[data-t="recorridos"]', wait: '#rt-add',
        body: 'Una lista de senderos en orden, con un inicio, un fin, sus paradas y un guión por parada.' },
      { title: 'Crear un recorrido', anchor: '#rt-add',
        body: 'Aquí se arma entero, de principio a fin.',
        branches: [{ label: '🧭 Ver cómo se arma', steps: SUB_ARMAR_RECORRIDO }] },
      { title: 'Lo que ve el visitante', anchor: '#route-bar', panel: 'closed',
        body: 'Cierra el panel y toca el recorrido en esta barra: verás la misma ficha que ve quien llega, con la distancia, el desnivel y el botón de empezar.' },
    ] },
  { id: 'fotos', emoji: '🖼️', title: 'Clasificar fotos', block: 'later', panel: 'full', tab: 'fotos',
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

// Deja el panel de administración como lo pide el paso, y SOLO cuando cambia: si
// se reaplicara en cada paso, renderPanel() cerraría el formulario que la rama
// acaba de abrir.
async function applyStage(step, topic) {
  if (!topic || !CTX || !CTX.openAdminAt) return;
  const panel = step.panel || topic.panel, tab = step.tab || topic.tab || '';
  const key = `${panel}:${tab}`;
  if (key === _stage) return;
  _stage = key;
  if (panel === 'closed') { if (CTX.closeAdmin) CTX.closeAdmin(); }
  else await CTX.openAdminAt(tab, { edit: panel === 'sheet' });
  // El panel entra con una animación de 200 ms: medir antes deja el recuadro
  // torcido respecto al botón (se veía en la pestaña de senderos).
  await sleep(280);
}

async function renderStep() {
  if (!_run) return;
  const st = _run.steps[_run.i];
  const ov = ovEl(), hole = ov.querySelector('#gd-hole'), bub = ov.querySelector('#gd-bubble');
  if (!_run.painted) {
    // La guía manda en la pantalla: fuera fichas, avisos y popups de la app, que
    // si no acaban tapando justo el botón del paso siguiente.
    if (!st.keep && CTX && CTX.clearBoxes) { try { CTX.clearBoxes(); } catch (e) { /* mapa aún cargando */ } }
    await applyStage(st, _run.topic);
    try { if (st.go) await st.go(CTX); } catch (e) { console.warn('[guide] go', e && e.message); }
    if (st.wait) await waitFor(st.wait, 700);
  }
  const el = st.card ? null : await waitFor(st.anchor, _run.painted ? 0 : 400);
  // Traer el ancla a la vista: en Info o en la lista de especies el elemento del
  // paso vive fuera de pantalla, y sin esto el paso caía a tarjeta.
  if (el && !_run.painted) { try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); await sleep(60); } catch (e) { /* sin scroll */ } }
  const rect = usableRect(el);
  const n = _run.steps.length, last = _run.i === n - 1;
  const es = lang() !== 'en';
  const sub = _stack.length > 0;

  bub.innerHTML = `
    <div class="gd-h"><b>${esc(st.title)}</b><span class="gd-n">${_run.i + 1}/${n}</span></div>
    <p class="gd-b">${esc(st.body)}</p>
    ${st.why ? `<p class="gd-why">${esc(st.why)}</p>` : ''}
    ${st.action ? `<button class="gd-act" id="gd-act">${esc(st.action.label)}</button>` : ''}
    ${(st.branches || []).map((b, i) => `<button class="gd-branch" data-br="${i}">${esc(b.label)}</button>`).join('')}
    <div class="gd-btns">
      <button class="gd-x" id="gd-x">${esc(_run.exitLabel)}</button>
      <span class="gd-sp"></span>
      ${_run.i ? `<button class="gd-prev" id="gd-prev">${es ? 'Atrás' : 'Back'}</button>` : ''}
      <button class="gd-next" id="gd-next">${last ? (sub ? (es ? '↩ Volver' : '↩ Back') : (es ? 'Listo' : 'Done')) : (es ? 'Siguiente' : 'Next')}</button>
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
  bub.querySelectorAll('.gd-branch').forEach((b) => b.onclick = () => enterBranch(st.branches[+b.dataset.br]));
  bub.querySelector('#gd-x').onclick = () => closeGuide();
  const prev = bub.querySelector('#gd-prev');
  if (prev) prev.onclick = () => { _run.i--; _run.painted = false; renderStep(); };
  bub.querySelector('#gd-next').onclick = () => {
    if (_run.i < n - 1) { _run.i++; _run.painted = false; renderStep(); } else finishTopic();
  };
}

// Entrar en una rama: el nodo padre queda esperando y se vuelve a él al terminar.
function enterBranch(br) {
  if (!br) return;
  _stack.push(_run);
  _run = { steps: br.steps, i: 0, painted: false, exitLabel: _run.exitLabel, topic: _run.topic };
  renderStep();
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

function startTopic(steps, { exitLabel, after = null, restore = null, topic = null } = {}) {
  _stack = []; _stage = null;
  _run = { steps, i: 0, painted: false, topic, after, restore,
    exitLabel: exitLabel || (lang() === 'en' ? '✕ Close' : '✕ Cerrar') };
  ovEl().classList.add('open');
  if (CTX && CTX.pushBack) CTX.pushBack('guide', () => closeGuide(true));
  watchLayout(true);
  renderStep();
}

function finishTopic() {
  // ¿Veníamos de una rama? Se vuelve al nodo que la abrió; no se cierra nada.
  if (_stack.length) {
    _run = _stack.pop();
    _run.painted = false;
    _stage = null;               // el nodo padre reconstruye su pantalla
    renderStep();
    return;
  }
  const after = _run && _run.after;
  closeGuide();                  // cerrar deja la app EN el sitio del tema
  if (after) after();
}

function closeGuide(fromBack) {
  if (!_run) { const o = document.getElementById('gd-ov'); if (o) o.classList.remove('open'); return; }
  const root = _stack.length ? _stack[0] : _run;
  const restore = root.restore;
  _run = null; _stack = []; _stage = null;
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
  ov.querySelector('#gd-hole').style.display = 'none';
  bub.classList.add('gd-card'); bub.style.cssText = '';
  bub.innerHTML = `<div class="gd-h"><b>${en ? 'Help' : 'Ayuda'}</b></div>
    ${groups.map((g, gi) => `<div class="gd-grp">${g.label ? `<div class="gd-grp-h">${esc(g.label)}</div>` : ''}
      ${g.rows.map((r, ri) => `<button class="gd-item" data-g="${gi}" data-i="${ri}"><span>${r.emoji}</span> ${esc(r.label)}</button>`).join('')}</div>`).join('')}
    <div class="gd-btns"><span class="gd-sp"></span><button class="gd-x" id="gd-x">${en ? 'Close' : 'Cerrar'}</button></div>`;
  if (CTX && CTX.pushBack) CTX.pushBack('guide', () => ov.classList.remove('open'));
  bub.querySelector('#gd-x').onclick = () => { ov.classList.remove('open'); if (CTX && CTX.popBack) CTX.popBack('guide'); };
  bub.querySelectorAll('.gd-item').forEach((b) => b.onclick = () => groups[+b.dataset.g].rows[+b.dataset.i].run());
}

// ---- tour del visitante ----
// Dos versiones: quien está EN la reserva ve el tour completo (recorridos,
// ubicación, audioguía); quien entra como invitado ve el corto, sin prometerle
// senderos que no puede caminar desde su casa.
function startVisitor() {
  const prevRoute = CTX && CTX.state ? CTX.state.activeRoute : null;
  const prevView = CTX && CTX.currentView ? CTX.currentView() : 'recorridos';
  _shown = true;
  startTopic((isGuest() ? GUEST : VISITOR)[lang()], {
    exitLabel: lang() === 'en' ? '✕ Skip' : '✕ Cerrar',
    // El tour cambió de pestaña y encendió un recorrido de ejemplo. Devolverlo es
    // estado de VISTA, no datos: no hay nada que deshacer en la nube.
    restore: () => {
      try { CTX.switchView(prevView); } catch (e) { /* vista ausente */ }
      try { if (CTX.state.activeRoute !== prevRoute) CTX.selectRoute(prevRoute); } catch (e) { /* mapa aún cargando */ }
      try { CTX.clearBoxes(); } catch (e) { /* nada abierto */ }
    },
  });
}

// Invitado: sale en CADA entrada (no tiene cuenta ni progreso que recordar).
// Visitante con cuenta: una sola vez, encadenado al «Empezar» del onboarding.
export function startVisitorTourOnce() {
  if (_shown) return;
  if (isGuest()) { if (CTX) startVisitor(); else _pendingVisitor = true; return; }
  if (localStorage.getItem('cantares_guide_seen')) return;
  localStorage.setItem('cantares_guide_seen', '1');
  if (!CTX) { _pendingVisitor = true; return; }
  startVisitor();
}

// ---- temas de admin ----
function startAdminTopic(topic, rest = []) {
  // Abrir el panel dispara maybeStartAdminGuide: sin esta bandera, elegir un
  // tema del índice en una instalación nueva lanzaría además la bienvenida.
  _starting = true;
  startTopic(topic.steps, {
    topic,
    exitLabel: rest.length ? '✕ Dejarlo para luego' : '✕ Cerrar',
    after: rest.length ? () => startAdminTopic(rest[0], rest.slice(1)) : null,
  });
  _starting = false;
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
//        openAdminAt, closeAdmin, clearBoxes, openLegend }
export function initGuide(ctx) {
  CTX = ctx;
  const btn = document.getElementById('help-btn');
  if (btn) btn.onclick = () => openGuideIndex();
  if (_pendingVisitor) { _pendingVisitor = false; startVisitor(); }
  // El invitado no pasa por el onboarding en cada visita, así que su tour corto
  // se lanza aquí, ya con el mapa listo.
  else if (isGuest() && !_shown) setTimeout(() => {
    const ob = document.getElementById('onboarding');
    const abierto = ob && !ob.classList.contains('hidden');
    if (!_run && !abierto) startVisitor();   // si el onboarding esta abierto, lo lanza su boton
  }, 600);
}

// Para las pruebas: el contenido sin el DOM.
export const _TOPICS = { visitor: VISITOR, guest: GUEST, admin: ADMIN };
