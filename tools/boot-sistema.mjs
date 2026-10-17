// node tools/boot-sistema.mjs  — liga o PC como no navegador (sem CD pré-carregado): GLaBIOS + disks/FD14BOOT.img,
// espera o FreeDOS chegar ao prompt A:\> e imprime a tela.
import fs from 'node:fs';
import { Motherboard } from '../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16, hddMB: 4 });
mb.setBIOSBinary(new Uint8Array(fs.readFileSync('roms/GLABIOS_0.4.2_8P.ROM')));
const IMG = new Uint8Array(fs.readFileSync('disks/FD14BOOT.img'));
{ const pat = Buffer.from('CALL SETUP.BAT floppy'), rep = Buffer.from('REM  SETUP.BAT floppy'); const b = Buffer.from(IMG.buffer, IMG.byteOffset, IMG.length); let i = -1; while ((i = b.indexOf(pat, i + 1)) >= 0) rep.copy(b, i); }
mb.loadDiskImage(0, IMG);
const L = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
mb.powerOn();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scr = () => { const rows = []; for (let y = 0; y < 25; y++) { let s = ''; for (let x = 0; x < 80; x++) { const v = mb.mem.read8(0xB8000 + (y * 80 + x) * 2); s += v >= 32 && v < 127 ? String.fromCharCode(v) : ' '; } rows.push(s.trimEnd()); } while (rows.length && !rows[rows.length - 1]) rows.pop(); return rows.join('\n'); };
const press = async (code) => { mb.kbd.keyDown(code); await sleep(110); mb.kbd.keyUp(code); await sleep(90); };
let ok = false, last = '', still = 0;
for (let i = 0; i < 90 && !ok; i++) {
  await sleep(500);
  const cur = scr(); ok = /A:\\>/.test(cur);
  if (cur === last) still++; else still = 0; last = cur;
  // tela parada há ~3 s e ainda sem prompt: o FreeDOS está esperando uma tecla; manda Enter (ou F, se pedir Fail?)
  if (!ok && still >= 6) { await press(/\(F\)ail\?/.test(cur) ? 'KeyF' : 'Enter'); still = 0; }
}
mb.powerOff(); console.log = L;
L(scr()); L(ok ? '\n✔ FreeDOS chegou ao prompt A:\\>' : '\n✘ prompt A:\\> não apareceu em 40 s');
L(`erros da CPU: ${mb._loopErrors}`); process.exit(ok ? 0 : 1);
