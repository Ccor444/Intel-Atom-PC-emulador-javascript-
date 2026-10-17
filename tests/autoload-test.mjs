// node autoload-test.mjs [ok|404]   — executa o src/main.js REAL com DOM/fetch simulados.
import fs from 'node:fs';
const mode = process.argv[2] || 'ok';

// ---- imagem sintética de 1,44 MB (NUNCA gravada em disks/) ----------------
const IMG = new Uint8Array(1474560);
const boot = [0xFA,0x31,0xC0,0x8E,0xD8,0x8E,0xC0,0x8E,0xD0,0xBC,0x00,0x7C,0xFB,
  0xB8,0x01,0x02, 0xBB,0x00,0x80, 0xB9,0x12,0x4F, 0xBA,0x00,0x01, 0xCD,0x13, 0x72,0x18,
  0xBE,0x3E,0x7C, 0xB4,0x0E, 0xAC,0x84,0xC0,0x74,0x04,0xCD,0x10,0xEB,0xF7,
  0xA0,0x00,0x80, 0xB4,0x0E, 0xCD,0x10, 0xF4,0xEB,0xFD,
  0xB0,0x45,0xB4,0x0E,0xCD,0x10,0xF4,0xEB,0xFD];
while (boot.length < 62) boot.push(0);
for (const ch of 'FD OK:\0') boot.push(ch.charCodeAt(0));
IMG.set(boot, 0); IMG[510] = 0x55; IMG[511] = 0xAA;
IMG[2879 * 512] = 'Z'.charCodeAt(0);              // 1º byte do ÚLTIMO setor (cil 79, cab 1, set 18)

// ---- ISO sintética pequena (64 setores) com ISO9660 + El Torito ----------------
const ISO = new Uint8Array(64 * 2048);
const put = (lba, off, arr) => ISO.set(arr, lba * 2048 + off);
const cc = (t) => [...t].map((c) => c.charCodeAt(0));
put(16, 0, [1, ...cc('CD001'), 1]); put(16, 40, cc('FD14LIVE'.padEnd(32))); put(16, 80, [64, 0, 0, 0]);
put(17, 0, [0, ...cc('CD001'), 1, ...cc('EL TORITO SPECIFICATION')]); put(17, 71, [20, 0, 0, 0]);
put(20, 0, [1]); put(20, 30, [0x55, 0xAA]); put(20, 32, [0x88, 2, 0, 0, 0, 0, 4, 0, 30, 0, 0, 0]);

// ---- ambiente de navegador falso ----------------------------------------
const log = [];
const mkCls = () => { const c = new Set(); return { add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x), toggle(x) { if (c.has(x)) c.delete(x); else c.add(x); } }; };
const el = () => { const base = { classList: mkCls(), style: {}, children: [], textContent: '', className: '', type: '', appendChild(c) { this.children.push(c); }, addEventListener() {} }; return new Proxy(base, { get: (t, k) => k in t ? t[k] : undefined, set: (t, k, v) => (t[k] = v, true) }); };
const els = {};
globalThis.document = { getElementById: (id) => (els[id] ||= el()), createElement: () => el() };
document.createElement = () => el();
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
els.screen = { getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }), width: 640, height: 400 };
globalThis.fetch = async (path) => {
  if (path === 'roms/GLABIOS_0.4.2_8P.ROM' && mode === 'msx') { const m = process.env.MSX_ROM ? new Uint8Array(fs.readFileSync(process.env.MSX_ROM)) : (() => { const z = new Uint8Array(32768); z[0] = 0x41; z[1] = 0x42; return z; })(); return { ok: true, status: 200, arrayBuffer: async () => m.buffer }; }
  if (path === 'roms/GLABIOS_0.4.2_8P.ROM') { const b = fs.readFileSync(path); return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; }
  if (path === 'disks/FD14LIVE.iso' && mode !== '404') return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => ISO.buffer };
  if (path === 'disks/FD14BOOT.img' && mode !== '404') return { ok: true, status: 200, arrayBuffer: async () => IMG.buffer };
  return { ok: false, status: 404 };
};
const oc = console.log, ow = console.warn; console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[DISK]') || s.startsWith('[MAIN]')) oc(s); };
console.warn = (...a) => { const s = a.join(' '); if (s.startsWith('[DISK]')) oc(s); };

await import('../src/main.js');
await new Promise((r) => setTimeout(r, 300));        // deixa os fetch terminarem
const mb = window.mb;

// clica em Power SEM esperar — o handler tem de aguardar o carregamento sozinho
const click = els['btn-power'].onclick();
await click; await new Promise((r) => setTimeout(r, 3000));
const txt = () => { let o = ''; for (let y = 0; y < 25; y++) { let l = ''; for (let x = 0; x < 80; x++) { const c = mb.mem.read8(0xB8000 + (y * 80 + x) * 2); l += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; } if (l.trim()) o += '|' + l.trimEnd() + '\n'; } return o; };
oc(txt()); oc(`erros=${mb._loopErrors}`);
oc(`painel: BIOS="${els['s-bios']?.textContent}"  Disco A:="${els['s-disk']?.textContent}"`);
const t = txt();
const good = mode !== '404' ? t.includes('FD OK:Z') : t.includes('Boot OK - Halted.');
// ISO: pré-carregada (modo ok) ou ausente (modo 404); depois seleção manual pelo seletor
const cdTxt = els['s-cd']?.textContent;
if (mode === 'msx') { const bt = els['s-bios'].textContent; oc(`painel BIOS: "${bt}"`); oc((bt.includes('MSX') || bt.includes('Z80')) && bt.includes('stub') ? '✔ ROM de MSX recusada com motivo no painel (e o PC usa o stub)' : '✘ ROM de MSX NÃO foi recusada'); }
oc(`painel CD-ROM: "${cdTxt}"`);
const preload = false;   // pré-carregamento do CD está desligado por padrão (ISO_PATH = null); para testar o caminho ligado, use uma cópia com ISO_PATH ativo
const cdOk = preload ? (cdTxt.includes('FD14LIVE') && cdTxt.includes('boot El Torito') && mb.cdrom.image?.sectors === 64)
                           : (cdTxt.startsWith('nenhum') && mb.cdrom.image === null);
oc(cdOk ? `✔ CD-ROM (${mode}): comportamento correto` : `✘ CD-ROM (${mode}) FALHOU`);
const blob = Object.assign(new Blob([ISO]), { name: 'manual.iso' });
await els['iso-input'].onchange({ target: { files: [blob] } });
const man = els['s-cd'].textContent;
const manOk = man.includes('manual.iso') && mb.cdrom.image?.name === 'manual.iso' && mb.cdrom.image.sectors === 64;
oc(`painel após seletor: "${man}"`);
oc(manOk ? '✔ seletor de ISO (File por streaming) funciona' : '✘ seletor de ISO FALHOU');
oc(good ? `✔ modo ${mode}: ${mode !== '404' ? 'imagem de 1,44 MB carregada sozinha; setor 2879 lido via INT 13h' : 'sem imagem em disks/: caiu no MBR Hello'}` : `✘ modo ${mode} FALHOU`);
mb.powerOff(); process.exit(good && cdOk && manOk && !mb._loopErrors ? 0 : 1);
