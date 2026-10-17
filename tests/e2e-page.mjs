// node tests/e2e-page.mjs — executa a PÁGINA (src/main.js) com DOM mínimo e fetch real de roms/ e disks/:
// carrega BIOS e disquete sozinhos, clica POWER, espera o FreeDOS chegar a A:\> e confere a tela.
import fs from 'node:fs';
let fails = 0; const say = (s) => process.stdout.write(s + '\n'); const ok = (c, m) => { say(`${c ? '✔' : '✘'} ${m}`); if (!c) fails++; };
const els = {};
const mkCls = () => { const c = new Set(); return { add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x), toggle(x) { if (c.has(x)) c.delete(x); else c.add(x); } }; };
const el = () => { const base = { classList: mkCls(), style: {}, children: [], textContent: '', className: '', type: '', appendChild(c) { this.children.push(c); }, addEventListener() {}, getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }), width: 640, height: 400 }; return new Proxy(base, { get: (t, k) => k in t ? t[k] : undefined, set: (t, k, v) => (t[k] = v, true) }); };
globalThis.document = { getElementById: (id) => (els[id] ||= el()), createElement: () => el(), baseURI: 'http://localhost/' };
globalThis.window = globalThis; globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
els.screen = el();
const real = (p) => { const b = fs.readFileSync(p); return { ok: true, status: 200, headers: { get: () => String(b.length) }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; };
globalThis.fetch = async (p) => {
  if (p === 'roms/GLABIOS_0.4.2_8P.ROM') return real('roms/GLABIOS_0.4.2_8P.ROM');
  if (p === 'disks/FD14BOOT.img') return real('disks/FD14BOOT.img');
  return { ok: false, status: 404 };
};
const lg = console.log, wn = console.warn; console.log = (...a) => { if (String(a[0]).startsWith('[DISK]') || String(a[0]).startsWith('[MAIN]')) lg(...a); }; console.warn = () => {};
await import('../src/main.js');
await new Promise((r) => setTimeout(r, 300));
const mb = window.mb;
ok(els['s-disk'].textContent.startsWith('FD14BOOT.img'), `painel Disco A: "${els['s-disk'].textContent}"`);
await els['btn-power'].onclick();                       // POWER como o usuário clicaria
const screen = () => { let o = ''; for (let k = 0; k < 2000; k++) o += String.fromCharCode(mb.mem.read8(0xB8000 + k * 2) || 32); return o; };
const press = async (c) => { mb.kbd.keyDown(c); await new Promise((r) => setTimeout(r, 110)); mb.kbd.keyUp(c); await new Promise((r) => setTimeout(r, 90)); };
let booted = false, last = '', still = 0;
for (let i = 0; i < 120 && !booted; i++) { await new Promise((r) => setTimeout(r, 500)); const cur = screen(); booted = /A:\\>/.test(cur); if (cur === last) still++; else still = 0; last = cur; if (!booted && still >= 6) { await press('Enter'); still = 0; } }
ok(booted, 'página: POWER → FreeDOS chega ao prompt A:\\>');
// caminho manual: escolher o disquete pelo seletor também pula o instalador (verifica o disquete na memória)
{ const manualBuf = fs.readFileSync('disks/FD14BOOT.img');
  await els['disk-input'].onchange({ target: { files: [{ name: 'FD14BOOT.img', size: manualBuf.length, arrayBuffer: async () => manualBuf.buffer.slice(manualBuf.byteOffset, manualBuf.byteOffset + manualBuf.length) }] } });
  const txt = Buffer.from(mb.floppy.data).toString('latin1');
  ok(txt.includes('REM  SETUP.BAT floppy') && !txt.includes('CALL SETUP.BAT floppy'), 'seletor manual: instalador desviado no disquete em memória'); }
if (!booted) { const rows = []; for (let y = 0; y < 25; y++) { let r = ''; for (let x = 0; x < 80; x++) { const v = mb.mem.read8(0xB8000 + (y * 80 + x) * 2); r += v >= 32 && v < 127 ? String.fromCharCode(v) : ' '; } if (r.trim()) rows.push(r.trimEnd()); } say('--- tela ---\n' + rows.join('\n')); say(`running=${mb.running} IP=${mb.loopStatus().ip} halted=${mb.cpu.halted} ciclos=${mb.cycleCount} erros=${mb._loopErrors} FDD sw1=${mb.ppi.sw1.toString(16)} floppy=${!!mb.floppy.data}`); }
mb.powerOff && 0;
console.log = lg; console.warn = wn;
ok(mb._loopErrors === 0, `erros da CPU: ${mb._loopErrors}`);
say(fails ? `\n✘ ${fails} falha(s)` : '\n✔ página de ponta a ponta: FreeDOS iniciou'); process.exit(fails ? 1 : 0);
