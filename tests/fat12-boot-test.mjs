// node fat12-boot-test.mjs [roms/GLABIOS_0.4.2_8P.ROM]
// Boot de ponta a ponta na GLaBIOS REAL: um boot sector FAT12 no estilo do FreeDOS procura "KERNEL  SYS" com
// `repe cmpsb` entre entradas de nome parecido, segue uma cadeia FAT12 fragmentada (clusters pares e ímpares,
// `and dh,0x0F`) e carrega o "kernel" em 1000:0000. O teste confere cada byte carregado e a tela ("...OK").
import fs from 'node:fs';
import { Motherboard } from '../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const BOOT = Buffer.from('eb3c9054455354424f4f54000201010002e000400bf00900120002000000000000000000000029785634124e4f204e414d45202020204641543132202020fa31c08ed88ec08ed0bc007cfbfc88161e7db81300b90e00bb00805051e8940059584081c30002e2f2bf0080bae000be217db90b0057f3a65f740883c7204a75eeeb6a8b451aa31f7db80100b90900bb00a05051e85d0059584081c30002e2f2b800108ec031dba11f7d83c01fe844008cc083c0208ec0b82e0ecd10a11f7d89c6d1ee01c68b9400a0a8017406b104d3eaeb0380e60f89161f7d81faf80f72c7b84f0ecd10b84b0ecd10f4ebfdb8450ecd10ebf6505351525631d2b91200f7f188d1fec131d2be0200f7f688c588d68a161e7db80102cd1372d35e5a595b58c30000004b45524e454c202053595300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000055aa', 'hex');                          // 512 bytes (fonte: fat12/fat12boot.S)
const romPath = process.argv[2] || 'roms/GLABIOS_0.4.2_8P.ROM';

// ---------- imagem FAT12 de 1,44 MB ----------
const img = new Uint8Array(1474560); img.set(BOOT, 0);
const FAT1 = 1 * 512, FAT2 = 10 * 512, ROOT = 19 * 512, DATA = 33 * 512;
const fatSet = (c, v) => { for (const base of [FAT1, FAT2]) { const o = base + Math.floor(c * 3 / 2);
  if (c & 1) { img[o] = (img[o] & 0x0F) | ((v & 0x0F) << 4); img[o + 1] = v >> 4; } else { img[o] = v & 0xFF; img[o + 1] = (img[o + 1] & 0xF0) | ((v >> 8) & 0x0F); } } };
fatSet(0, 0xFF0); fatSet(1, 0xFFF);
let seed = 99; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF) / 0x7FFFFFFF;
const chain = [2]; const used = new Set([2]);
while (chain.length < 91) { const c = 3 + Math.floor(rnd() * 400); if (!used.has(c)) { used.add(c); chain.push(c); } }   // fragmentado, pares e ímpares
for (let i = 0; i < chain.length; i++) fatSet(chain[i], i + 1 < chain.length ? chain[i + 1] : 0xFFF);
const content = (c, i) => (c * 37 + i * 3 + 11) & 255;
for (const c of [...chain, 450, 451, 452, 453]) for (let i = 0; i < 512; i++) img[DATA + (c - 2) * 512 + i] = content(c, i);
for (const c of [450, 451, 452, 453]) fatSet(c, 0xFFF);
const entry = (n, name, cl, size) => { const o = ROOT + n * 32; for (let i = 0; i < 11; i++) img[o + i] = name.charCodeAt(i); img[o + 11] = 0x20; img[o + 0x1A] = cl & 255; img[o + 0x1B] = cl >> 8; for (let i = 0; i < 4; i++) img[o + 0x1C + i] = (size >> (8 * i)) & 255; };
entry(0, 'XERNEL  SYS', 450, 512); entry(1, 'KERNEL  SYT', 451, 512); entry(2, 'OTHER   SYS', 452, 512);   // iscas: só o último byte (ou quase) bate
entry(3, 'KERNEL  BAK', 453, 512); entry(4, 'KERNEL  SYS', 2, 91 * 512);                                   // a verdadeira

// ---------- boot ----------
const cv = { getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) };
const mb = new Motherboard(cv, { ramMB: 16 });
mb.setBIOSBinary(new Uint8Array(fs.readFileSync(romPath)));
mb.loadDiskImage(0, img);
const log = console.log; console.log = () => {}; console.warn = () => {};
mb.powerOn(); await new Promise((r) => setTimeout(r, 5000)); mb.powerOff(); console.log = log;

let bad = -1, wrongAt = [];
for (let i = 0; i < chain.length * 512 && wrongAt.length < 3; i++) if (mb.mem.read8(0x10000 + i) !== content(chain[(i / 512) | 0], i % 512)) wrongAt.push(i);
const rows = []; for (let y = 0; y < 25; y++) { let l = ''; for (let x = 0; x < 80; x++) { const c = mb.mem.read8(0xB8000 + (y * 80 + x) * 2); l += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; } rows.push(l.trimEnd()); }
const txt = rows.join('\n'); const dots = (txt.match(/\./g) || []).length;
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); return c; };
let good = true;
good &= ok(wrongAt.length === 0, wrongAt.length ? `kernel carregado ERRADO (primeiros bytes diferentes em +${wrongAt.join(', +')})` : `kernel de ${chain.length} clusters (${chain.length * 512} bytes) carregado byte a byte em 1000:0000`);
good &= ok(dots >= 91 && /OK/.test(txt), `tela: ${dots} pontos${/OK/.test(txt) ? ' e "OK"' : ' e SEM "OK"'}${/E\s*$/m.test(txt) && !/OK/.test(txt) ? ' (erro "E")' : ''}`);
good &= ok(mb._loopErrors === 0, `erros da CPU: ${mb._loopErrors}`);
console.log(good ? '\n✔ boot FAT12 estilo FreeDOS: passou' : '\n✘ boot FAT12 estilo FreeDOS: FALHOU'); process.exit(good ? 0 : 1);
