'use strict';
// ============================================================
// Teclado virtual (layout US) para telas de toque
// ============================================================
// Envia exatamente o que o teclado físico envia: mb.kbd.keyDown(code) / keyUp(code), com os códigos
// KeyboardEvent.code (KeyA, Digit1, ShiftLeft...). O emulador não sabe a diferença.
// Shift, Ctrl e Alt ficam "travados" ao toque: o próximo toque em outra tecla é digitado com o modificador
// e ao soltar a tecla o modificador é solto. Toque de novo no modificador para soltá-lo sem digitar nada.

// Cada tecla: c = código, l = rótulo, s = rótulo com Shift (opcional), w = largura relativa.
export const LAYOUT = [
  [ { c: 'Escape', l: 'Esc', w: 1.4 },
    ...[1,2,3,4,5,6,7,8,9,10].map((n) => ({ c: 'F' + n, l: 'F' + n })) ],
  [ { c: 'Backquote', l: '`', s: '~' },
    ...'1234567890'.split('').map((d, i) => ({ c: 'Digit' + (d), l: d, s: '!@#$%^&*()'[i] })),
    { c: 'Minus', l: '-', s: '_' }, { c: 'Equal', l: '=', s: '+' },
    { c: 'Backspace', l: '⌫', w: 2 } ],
  [ { c: 'Tab', l: 'Tab', w: 1.5 },
    ...'qwertyuiop'.split('').map((ch) => ({ c: 'Key' + ch.toUpperCase(), l: ch, s: ch.toUpperCase() })),
    { c: 'BracketLeft', l: '[', s: '{' }, { c: 'BracketRight', l: ']', s: '}' },
    { c: 'Backslash', l: '\\', s: '|', w: 1.5 } ],
  [ { c: 'CapsLock', l: 'Caps', w: 1.75 },
    ...'asdfghjkl'.split('').map((ch) => ({ c: 'Key' + ch.toUpperCase(), l: ch, s: ch.toUpperCase() })),
    { c: 'Semicolon', l: ';', s: ':' }, { c: 'Quote', l: "'", s: '"' },
    { c: 'Enter', l: 'Enter', w: 2.25 } ],
  [ { c: 'ShiftLeft', l: 'Shift', w: 2.25, mod: true },
    ...'zxcvbnm'.split('').map((ch) => ({ c: 'Key' + ch.toUpperCase(), l: ch, s: ch.toUpperCase() })),
    { c: 'Comma', l: ',', s: '<' }, { c: 'Period', l: '.', s: '>' }, { c: 'Slash', l: '/', s: '?' },
    { c: 'ShiftRight', l: 'Shift', w: 2.75, mod: true } ],
  [ { c: 'ControlLeft', l: 'Ctrl', w: 1.5, mod: true }, { c: 'AltLeft', l: 'Alt', w: 1.5, mod: true },
    { c: 'Space', l: 'Espaço', w: 5 },
    { c: 'Home', l: 'Home' }, { c: 'End', l: 'End' }, { c: 'PageUp', l: 'PgUp' }, { c: 'PageDown', l: 'PgDn' },
    { c: 'Insert', l: 'Ins' }, { c: 'Delete', l: 'Del' } ],
  [ { c: 'ArrowLeft', l: '←' }, { c: 'ArrowUp', l: '↑' }, { c: 'ArrowDown', l: '↓' }, { c: 'ArrowRight', l: '→' } ],
];

export const MODS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'AltLeft']);

/** Todos os códigos do layout (para validar contra o mapa do teclado). */
export function layoutCodes() {
  return LAYOUT.flat().map((k) => k.c);
}

/**
 * @param {object} mb         Motherboard (usa mb.kbd no momento de cada tecla)
 * @param {HTMLElement} container  elemento que recebe o teclado
 * @returns {{pressKey, releaseKey, show, hide, toggle, isVisible, latched}}
 */
export function createVirtualKeyboard(mb, container) {
  const doc = container.ownerDocument || document;
  const latched = new Set();     // modificadores travados
  const held = new Set();        // teclas normais seguradas
  const views = [];              // { el, k }

  const shiftOn = () => latched.has('ShiftLeft') || latched.has('ShiftRight');

  function render() {
    for (const { el, k } of views) {
      const label = shiftOn() && k.s ? k.s : k.l;
      if (el.textContent !== label) el.textContent = label;
      const on = MODS.has(k.c) && latched.has(k.c);
      if (on) el.classList.add('on'); else el.classList.remove('on');
    }
  }

  function pressKey(code) {
    if (MODS.has(code)) {
      if (latched.has(code)) { latched.delete(code); mb.kbd.keyUp(code); }
      else { latched.add(code); mb.kbd.keyDown(code); }
      render();
      return;
    }
    if (held.has(code)) return;
    held.add(code);
    mb.kbd.keyDown(code);
  }

  function releaseKey(code) {
    if (MODS.has(code)) return;                 // modificador solta ao tocar de novo, não ao levantar o dedo
    if (!held.has(code)) return;
    held.delete(code);
    mb.kbd.keyUp(code);
    // tecla normal solta: solta os modificadores travados que estavam aplicados a ela
    for (const m of [...latched]) { latched.delete(m); mb.kbd.keyUp(m); }
    render();
  }

  // ---- montagem da interface ---------------------------------------------
  container.textContent = '';
  for (const row of LAYOUT) {
    const rowEl = doc.createElement('div');
    rowEl.className = 'vkb-row';
    for (const k of row) {
      const el = doc.createElement('button');
      el.type = 'button';
      el.className = 'vkb-key' + (MODS.has(k.c) ? ' mod' : '') + (k.l.length > 2 ? ' wide' : '');
      el.style.flexGrow = String(k.w || 1);
      el.textContent = k.l;
      const down = (e) => { if (e.preventDefault) e.preventDefault(); pressKey(k.c); };
      const up = () => releaseKey(k.c);
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointerleave', up);
      el.addEventListener('pointercancel', up);
      rowEl.appendChild(el);
      views.push({ el, k });
    }
    container.appendChild(rowEl);
  }
  container.classList.add('vkb');
  render();

  return {
    pressKey,
    releaseKey,
    show() { container.classList.remove('hidden'); },
    hide() { container.classList.add('hidden'); },
    toggle() { container.classList.toggle('hidden'); },
    isVisible() { return !container.classList.contains('hidden'); },
    latched() { return [...latched]; },
  };
}
