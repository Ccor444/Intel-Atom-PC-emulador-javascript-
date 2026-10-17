// node tools/dos-prompt.mjs "comando1" "comando2" ...  — boot do FreeDOS (disquete) até o A:\> e digita comandos.
import fs from 'node:fs';
import { Motherboard } from '../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const cmds = process.argv.slice(2);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16, hddMB: 4 });
mb.setBIOSBinary(new Uint8Array(fs.readFileSync('roms/GLABIOS_0.4.2_8P.ROM')));
const IMG = new Uint8Array(fs.readFileSync('disks/FD14BOOT.img'));
{ const pat = Buffer.from('CALL SETUP.BAT floppy'), rep = Buffer.from('REM  SETUP.BAT floppy'); const b = Buffer.from(IMG.buffer, IMG.byteOffset, IMG.length); let i = -1; while ((i = b.indexOf(pat, i + 1)) >= 0) rep.copy(b, i); }
mb.loadDiskImage(0, IMG);
const L = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
mb.powerOn();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scr = () => { const rows = []; for (let y = 0; y < 25; y++) { let s = ''; for (let x = 0; x < 80; x++) { const v = mb.mem.read8(0xB8000 + (y * 80 + x) * 2); s += v >= 32 && v < 127 ? String.fromCharCode(v) : ' '; } rows.push(s.trimEnd()); } while (rows.length && !rows[rows.length - 1]) rows.pop(); return rows.join('\n'); };
const press = async (code, sh = false) => { if (sh) mb.kbd.keyDown('ShiftLeft'); mb.kbd.keyDown(code); await sleep(110); mb.kbd.keyUp(code); if (sh) mb.kbd.keyUp('ShiftLeft'); await sleep(90); };
const typeT = async (t) => { for (const ch of t) { if (/[a-z]/i.test(ch)) await press('Key' + ch.toUpperCase()); else if (/[0-9]/.test(ch)) await press('Digit' + ch); else if (ch === ' ') await press('Space'); else if (ch === ':') await press('Semicolon', true); else if (ch === '\\') await press('Backslash'); else if (ch === '.') await press('Period'); else if (ch === '*') await press('Digit8', true); else if (ch === '-') await press('Minus'); else if (ch === '/') await press('Slash'); else if (ch === '\n') await press('Enter'); } };
let ok = false, last = '', still = 0;
for (let i = 0; i < 90 && !ok; i++) {
  await sleep(500); const cur = scr(); ok = /A:\\>/.test(cur);
  if (cur === last) still++; else still = 0; last = cur;
  if (!ok && still >= 6) { await press('Enter'); still = 0; }
}
if (!ok) { mb.powerOff(); console.log = L; L('✘ prompt não apareceu'); process.exit(1); }
for (const c of cmds) { await typeT(c + '\n'); await sleep(2500); }
await sleep(800);
mb.powerOff(); console.log = L;
L(scr()); L(`\nerros da CPU: ${mb._loopErrors}`);
