// node tests/vkeyboard-test.mjs  — teclado virtual: layout × mapa do teclado, mostrar/esconder, Shift travado,
// e digitação real no FreeDOS (disquete) pelos BOTÕES virtuais (pointerdown/pointerup).
import fs from 'node:fs';
import { Motherboard } from '../src/motherboard.js';
import { createVirtualKeyboard, LAYOUT, layoutCodes, MODS } from '../src/vkeyboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
let fails = 0; const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- DOM mínimo (só o necessário para o teclado) --------------------------------------------
function mkEl(tag) {
  const cls = new Set(); const listeners = {};
  const el = { tag, children: [], style: {}, textContent: '', className: '', type: '' };
  el.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
                   toggle(c) { if (cls.has(c)) cls.delete(c); else cls.add(c); } };
  el.appendChild = (c) => el.children.push(c);
  el.addEventListener = (t, f) => { (listeners[t] ||= []).push(f); };
  el.fire = (t) => { for (const f of listeners[t] || []) f({ preventDefault() {} }); };
  el.ownerDocument = { createElement: (t) => mkEl(t) };
  return el;
}
const container = mkEl('div'); container.classList.add('hidden');          // como no index.html

// ---- 1) layout × mapa de teclas ----------------------------------------------------------------
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });
const codes = layoutCodes();
const missing = codes.filter((c) => mb.kbd.map[c] === undefined);
ok(missing.length === 0, `todas as ${codes.length} teclas do layout existem no mapa do teclado${missing.length ? ' — faltam: ' + missing.join(',') : ''}`);
const vkb = createVirtualKeyboard(mb, container);
const buttons = container.children.flatMap((r) => r.children);
ok(buttons.length === codes.length, `um botão por tecla do layout (${buttons.length})`);
const btnOf = (code) => buttons[codes.indexOf(code)];

// ---- 2) mostrar / esconder ----------------------------------------------------------------------
ok(!vkb.isVisible() && container.classList.contains('hidden'), 'começa escondido');
vkb.toggle(); ok(vkb.isVisible(), 'toggle → visível');
vkb.toggle(); ok(!vkb.isVisible(), 'toggle de novo → escondido');
vkb.show(); ok(vkb.isVisible(), 'show() mostra'); vkb.hide(); ok(!vkb.isVisible(), 'hide() esconde');

// ---- 3) envio ao emulador e Shift travado ---------------------------------------------------------
const log = []; const kd = mb.kbd.keyDown.bind(mb.kbd), ku = mb.kbd.keyUp.bind(mb.kbd);
mb.kbd.keyDown = (c) => { log.push('D:' + c); return kd(c); };
mb.kbd.keyUp = (c) => { log.push('U:' + c); return ku(c); };
btnOf('KeyA').fire('pointerdown'); btnOf('KeyA').fire('pointerup');
ok(log.join(' ') === 'D:KeyA U:KeyA', `tecla normal: ${log.join(' ')}`);
log.length = 0;
btnOf('ShiftLeft').fire('pointerdown');
ok(vkb.latched().includes('ShiftLeft') && log.join(' ') === 'D:ShiftLeft', 'Shift toque → travado (keyDown enviado)');
btnOf('ShiftLeft').fire('pointerup');
ok(vkb.latched().includes('ShiftLeft'), 'soltar o dedo do Shift NÃO solta (continua travado)');
btnOf('Semicolon').fire('pointerdown'); btnOf('Semicolon').fire('pointerup');
ok(log.join(' ') === 'D:ShiftLeft D:Semicolon U:Semicolon U:ShiftLeft', `Shift+; → ${log.join(' ')}`);
ok(vkb.latched().length === 0, 'depois da tecla o Shift é solto sozinho');
log.length = 0;
btnOf('ShiftRight').fire('pointerdown'); btnOf('ShiftRight').fire('pointerdown');  // toque 2x = trava e depois solta, sem digitar
ok(vkb.latched().length === 0 && log.join(' ') === 'D:ShiftRight U:ShiftRight', `toque 2× no mesmo modificador solta: ${log.join(' ')}`);
log.length = 0;
// rótulo muda com Shift travado: 'a' → 'A' e ';' → ':'
btnOf('ShiftLeft').fire('pointerdown');
const lab = (c) => btnOf(c).textContent;
ok(lab('KeyA') === 'A' && lab('Semicolon') === ':' && lab('Digit1') === '!', `rótulos com Shift: A=${lab('KeyA')} ;=${lab('Semicolon')} 1=${lab('Digit1')}`);
btnOf('ShiftLeft').fire('pointerdown');
ok(lab('KeyA') === 'a' && lab('Semicolon') === ';', 'rótulos voltam ao normal ao soltar o Shift');
mb.kbd.keyDown = kd; mb.kbd.keyUp = ku;

// ---- 4) digitação real no FreeDOS pelos botões virtuais ---------------------------------------
const IMG = new Uint8Array(fs.readFileSync('disks/FD14BOOT.img'));
{ const pat = Buffer.from('CALL SETUP.BAT floppy'), rep = Buffer.from('REM  SETUP.BAT floppy'); const b = Buffer.from(IMG.buffer, IMG.byteOffset, IMG.length); let i = -1; while ((i = b.indexOf(pat, i + 1)) >= 0) rep.copy(b, i); }
const mb2 = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16, hddMB: 4 });
mb2.setBIOSBinary(new Uint8Array(fs.readFileSync('roms/GLABIOS_0.4.2_8P.ROM')));
mb2.loadDiskImage(0, IMG);
const cont2 = mkEl('div'); cont2.classList.add('hidden'); const vk2 = createVirtualKeyboard(mb2, cont2);
const btn2 = (c) => cont2.children.flatMap((r) => r.children)[layoutCodes().indexOf(c)];
const tap = async (c) => { btn2(c).fire('pointerdown'); await sleep(110); btn2(c).fire('pointerup'); await sleep(90); };
const screen = () => { const rows = []; for (let y = 0; y < 25; y++) { let s = ''; for (let x = 0; x < 80; x++) { const v = mb2.mem.read8(0xB8000 + (y * 80 + x) * 2); s += v >= 32 && v < 127 ? String.fromCharCode(v) : ' '; } rows.push(s.trimEnd()); } return rows.join('\n'); };
const L = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
mb2.powerOn();
let booted = false, last = '', still = 0;
for (let i = 0; i < 90 && !booted; i++) {
  await sleep(500); const cur = screen(); booted = /A:\\>/.test(cur);
  if (cur === last) still++; else still = 0; last = cur;
  if (!booted && still >= 6) { await tap('Enter'); still = 0; }
}
if (!booted) { mb2.powerOff(); console.log = L; ok(false, 'FreeDOS não chegou ao prompt'); process.exit(1); }
for (const c of ['KeyE','KeyC','KeyH','KeyO','Space','KeyH','KeyE','KeyL','KeyL','KeyO']) await tap(c);
btn2('ShiftLeft').fire('pointerdown');                    // Shift travado (toque, sem levantar)
await tap('Semicolon');                                    // digita ':' com Shift
for (const c of ['KeyW','KeyO','KeyR','KeyL','KeyD']) await tap(c);
await tap('Enter'); await sleep(1200);
const out = screen(); mb2.powerOff(); console.log = L;
ok(out.includes('hello:world'), `FreeDOS recebeu "echo hello:world" pelos botões virtuais${out.includes('hello:world') ? '' : ' — tela:\n' + out.split('\n').filter(Boolean).slice(-4).join('\n')}`);
ok(vk2.latched().length === 0, 'nenhum modificador ficou travado no fim');
ok(mb2._loopErrors === 0, `erros da CPU: ${mb2._loopErrors}`);

console.log(fails ? `\n✘ ${fails} falha(s)` : '\n✔ teclado virtual: todos os testes passaram'); process.exit(fails ? 1 : 0);
