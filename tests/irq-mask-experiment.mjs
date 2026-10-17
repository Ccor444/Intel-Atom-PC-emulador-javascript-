// node tests/irq-mask-experiment.mjs [mask|nomask] — dir em D:\FREEDOS\BIN com e sem IRQs mascarados durante o dir.
import fs from 'node:fs';
import { Motherboard } from '../src/motherboard.js';
import { loadCdFromFile } from '../src/cdrom.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const mode = process.argv[2] || 'nomask';
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16, hddMB: 4 });
mb.setBIOSBinary(new Uint8Array(fs.readFileSync('roms/GLABIOS_0.4.2_8P.ROM')));
const IMG = new Uint8Array(fs.readFileSync('disks/FD14BOOT.img'));
{ const pat = Buffer.from('CALL SETUP.BAT floppy'), rep = Buffer.from('REM  SETUP.BAT floppy'); const b = Buffer.from(IMG.buffer, IMG.byteOffset, IMG.length); let i = -1; while ((i = b.indexOf(pat, i + 1)) >= 0) rep.copy(b, i); }
mb.loadDiskImage(0, IMG); mb.loadCdImage(await loadCdFromFile(await fs.openAsBlob('disks/FD14LIVE.iso')));
const L = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
mb.powerOn();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scr = () => { const rows = []; for (let y = 0; y < 25; y++) { let s = ''; for (let x = 0; x < 80; x++) s += String.fromCharCode(mb.mem.read8(0xB8000 + (y * 80 + x) * 2) || 32); rows.push(s); } return rows.join('\n'); };
const press = async (c) => { mb.kbd.keyDown(c); await sleep(110); mb.kbd.keyUp(c); await sleep(90); };
const type = async (t) => { for (const ch of t) { if (/[a-z]/i.test(ch)) await press('Key' + ch.toUpperCase()); else if (ch === ' ') await press('Space'); else if (ch === ':') { mb.kbd.keyDown('ShiftLeft'); await press('Semicolon'); mb.kbd.keyUp('ShiftLeft'); } else if (ch === '\\') await press('Backslash'); else if (ch === '*') await press('Digit8'); else if (ch === '.') await press('Period'); } await press('Enter'); };
let last = '', still = 0;
for (let i = 0; i < 90; i++) { await sleep(500); const cur = scr(); if (/A:\\>/.test(cur)) break; if (cur === last) still++; else still = 0; last = cur; if (still >= 6) { await press('Enter'); still = 0; } }
await type('d:'); await sleep(3000); await type('cd freedos\\bin'); await sleep(3000);
if (mode === 'mask') mb.pic.master.imr = 0xFF;          // mascara IRQs no mestre (timer, teclado, FDC…)
await type('dir'); await sleep(5000);
const out = scr(); const m = out.match(/(\d+) file\(s\)/g);
mb.powerOff(); console.log = L;
console.log(`${mode}: ${m ? m[m.length - 1] : '(sem resumo do dir)'}  |  linhas com .EXE: ${(out.match(/\.EXE/g) || []).length}  |  "BZIP2" visto: ${out.includes('BZIP2')}`);
