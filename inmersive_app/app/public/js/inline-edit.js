// Edición EN SITIO: se toca el texto ya pintado y se edita ahí mismo, sobre la
// página real. No hay formulario aparte, ni pantalla aparte.
//
// Por qué. El editor de una especie era un modal a pantalla completa: para
// cambiar un nombre había que salir de la ficha, verla como una lista de
// <label> + <input>, guardar y volver. Nunca se veía CÓMO QUEDA hasta el final,
// que es justo lo que hay que ver cuando lo que estás ajustando es una página.
//
// El modo. Nada de esto se activa por ser admin: hay un interruptor por pestaña
// que enciende `body.is-editing`. Fuera de él, la app se comporta exactamente
// como para un visitante — tocar una foto la abre en grande, no la edita. Poder
// ver la página como la ve un visitante es parte del trabajo.
//
// Este módulo es SOLO interfaz: no sabe de Supabase ni de la cola offline. Quien
// llama pasa un `onSave(valor)` y decide qué hacer con él.

let editing = false;
const listeners = new Set();

export function isEditing() { return editing; }
export function onEditingChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function setEditing(on) {
  editing = !!on;
  document.body.classList.toggle('is-editing', editing);
  listeners.forEach((fn) => { try { fn(editing); } catch (e) { /* un oyente roto no apaga el modo */ } });
}

// Botón de encendido/apagado. Se le pasa dónde va y qué pasa al cambiar.
// `disabledReason` lo deja apagado y explica por qué al tocarlo: se usa cuando
// no se cargó la copia de la nube y guardar pisaría lo que hubiera guardado.
export function editToggleButton({ label, labelOn, disabledReason, onToggle, toast }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'edit-toggle';
  const paint = () => {
    b.textContent = editing ? (labelOn || '✓ Listo') : (label || '✏️ Editar');
    b.classList.toggle('on', editing);
  };
  b.onclick = () => {
    if (disabledReason) { if (toast) toast(disabledReason); return; }
    setEditing(!editing); paint(); if (onToggle) onToggle(editing);
  };
  if (disabledReason) { b.classList.add('off'); b.title = disabledReason; }
  paint();
  onEditingChange(paint);
  return b;
}

const isMultiline = (t) => t === 'area';

// Convierte un elemento YA PINTADO en editable. `el` conserva su sitio, su
// tipografía y su tamaño: por eso se edita dentro de él y no en un cuadro
// flotante — lo que ves mientras escribes es lo que va a quedar.
//
//   opts.value        valor actual (si falta, se usa el texto del elemento)
//   opts.type         'text' | 'area' | 'select'
//   opts.options      [{v, label}] para 'select'
//   opts.placeholder  qué poner cuando está vacío
//   opts.onSave(v)    se llama SÓLO si el valor cambió
export function inlineField(el, opts = {}) {
  if (!el) return;
  el.classList.add('ie-field');
  const type = opts.type || 'text';
  const get = () => (opts.value != null ? String(opts.value) : (el.textContent || '').trim());
  // El vacío necesita una pista visible: un hueco sin nada no se ve y no se
  // puede tocar, así que un campo sin valor no sería editable nunca.
  const paintEmpty = () => {
    if (!get() && opts.placeholder) { el.textContent = opts.placeholder; el.classList.add('ie-empty'); }
  };
  paintEmpty();

  el.onclick = (ev) => {
    if (!editing || el.classList.contains('ie-open')) return;
    ev.preventDefault(); ev.stopPropagation();
    const before = get();
    const prevHTML = el.innerHTML;
    el.classList.add('ie-open'); el.classList.remove('ie-empty');
    let input;
    if (type === 'select') {
      input = document.createElement('select');
      (opts.options || []).forEach((o) => {
        const op = document.createElement('option');
        op.value = o.v; op.textContent = o.label; if (String(o.v) === before) op.selected = true;
        input.appendChild(op);
      });
    } else {
      input = document.createElement(isMultiline(type) ? 'textarea' : 'input');
      input.value = before;
      if (opts.placeholder) input.placeholder = opts.placeholder;
      if (isMultiline(type)) input.rows = Math.min(14, Math.max(3, before.split('\n').length + 1));
    }
    input.className = 'ie-input';
    el.innerHTML = '';
    el.appendChild(input);
    input.focus();
    if (input.select) input.select();

    let done = false;
    const close = (commit) => {
      if (done) return; done = true;
      const after = input.value;
      el.classList.remove('ie-open');
      el.innerHTML = prevHTML;
      if (commit && after !== before) {
        // El repintado lo hace quien llama, con el dato ya guardado: este módulo
        // no sabe cómo se renderiza una especie ni una sección de la historia.
        if (opts.onSave) opts.onSave(after);
      } else {
        paintEmpty();
      }
    };
    input.onblur = () => close(true);
    input.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); input.blur(); }
      // Enter guarda en una línea; en un textarea Enter es un salto de párrafo y
      // se guarda con Ctrl/Cmd+Enter o saliendo del campo.
      if (e.key === 'Enter' && (!isMultiline(type) || e.ctrlKey || e.metaKey)) { e.preventDefault(); close(true); input.blur(); }
    };
    if (type === 'select') input.onchange = () => { close(true); };
  };
}
