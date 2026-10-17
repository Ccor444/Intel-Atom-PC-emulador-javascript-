// Rastreia TODA escrita de 8 bits em 0x11FD2..0x11FD5 (campo de LBA) durante: d: / cd freedos\bin / dir.
import fs from 'node:fs';
import { Motherboard } from '../src/motherboard.js';
import { loadCdFromFile } from '../src/cdrom.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16, hddMB: 4 });
mb.setBIOSBinary(new Uint8Array(fs.readFileSync('roms/GLABIOS_0.4.2_8P.ROM')));
const IMG = new Uint8Array(fs.readFileSync('disks/FD14BOOT.img'));
{ const pat = Buffer.from('CALL SETUP.BAT floppy'), rep = Buffer.from('REM  SETUP.BAT floppy'); const b = Buffer.from(IMG.buffer, IMG.byteOffset, IMG.length); let i = -1; while ((i = b.indexOf(pat, i + 1)) >= 0) rep.copy(b, i); }
mb.loadDiskImage(0, IMG); mb.loadCdImage(await loadCdFromFile(await fs.openAsBlob('disks/FD14LIVE.iso')));
const cpu = mb.cpu, mem = mb.mem, hx = (v, w = 2) => (v >>> 0).toString(16).padStart(w, '0');
const log = []; let armed = false;
const w8 = mem.write8.bind(mem); mem.write8 = (a, v) => { if (armed && a >= 0x113D0 && a <= 0x113D3) log.push(`w8 @${hx(a, 5)} = ${hx(v)}  por ${hx(cpu.sregs[1], 4)}:${hx(cpu.ip, 4)}  AX=${hx(cpu.r16(0), 4)} BX=${hx(cpu.r16(3), 4)} DS=${hx(cpu.sregs[3], 4)} SS=${hx(cpu.sregs[2], 4)}`); return w8(a, v); };
const w16 = mem.write16.bind(mem); mem.write16 = (a, v) => { if (armed && a + 1 >= 0x113D0 && a <= 0x113D3) log.push(`w16 @${hx(a, 5)} = ${hx(v, 4)}  por ${hx(cpu.sregs[1], 4)}:${hx(cpu.ip, 4)}`); return w16(a, v); };
const w32 = mem.write32.bind(mem); mem.write32 = (a, v) => { if (armed && a + 3 >= 0x113D0 && a <= 0x113D3) log.push(`w32 @${hx(a, 5)} = ${hx(v, 8)}  por ${hx(cpu.sregs[1], 4)}:${hx(cpu.ip, 4)}`); return w32(a, v); };
let prevEax = null; const hiChanges = []; const os = cpu.step.bind(cpu);
const ring = []; const RN = 80; let rolCtx = null;
cpu.step = () => {
  const cs = cpu.sregs[1], ip = cpu.ip, before = cpu.r32(0) >>> 0;
  if (armed) { const bb = []; for (let j = 0; j < 6; j++) bb.push(hx(mem.read8(((cs << 4) + ip + j) & 0xFFFFF))); ring.push(`${hx(cs, 4)}:${hx(ip, 4)} [${bb.join(' ')}] EAX=${hx(before, 8)} BX=${hx(cpu.r16(3), 4)} DI=${hx(cpu.r16(7), 4)} SI=${hx(cpu.r16(6), 4)} DS=${hx(cpu.sregs[3], 4)} ES=${hx(cpu.sregs[0], 4)}`); if (ring.length > RN) ring.shift(); }
  const r = os();
  if (armed && !rolCtx && cs === 0x1138 && ip === 0x052F) rolCtx = ring.slice(-RN).join('\n');
  const after = cpu.r32(0) >>> 0;
  if (armed && ((before >>> 16) !== (after >>> 16)) && hiChanges.length < 12) {
    const b = []; for (let j = 0; j < 6; j++) b.push(hx(mem.read8(((cs << 4) + ip + j) & 0xFFFFF)));
    hiChanges.push(`${hx(cs, 4)}:${hx(ip, 4)} [${b.join(' ')}]  EAX ${hx(before, 8)} -> ${hx(after, 8)}  BX=${hx(cpu.r16(3), 4)} DI=${hx(cpu.r16(7), 4)} SP=${hx(cpu.r16(4), 4)} SS=${hx(cpu.sregs[2], 4)}`);
  }
  return r;
};
const L = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
mb.powerOn();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scr = () => { let o = ''; for (let k = 0; k < 2000; k++) o += String.fromCharCode(mb.mem.read8(0xB8000 + k * 2) || 32); return o; };
const press = async (c) => { mb.kbd.keyDown(c); await sleep(110); mb.kbd.keyUp(c); await sleep(90); };
const type = async (t) => { for (const ch of t) { if (/[a-z]/i.test(ch)) await press('Key' + ch.toUpperCase()); else if (ch === ' ') await press('Space'); else if (ch === ':') { mb.kbd.keyDown('ShiftLeft'); await press('Semicolon'); mb.kbd.keyUp('ShiftLeft'); } else if (ch === '\\') await press('Backslash'); else if (ch === '*') await press('Digit8'); else if (ch === '.') await press('Period'); } await press('Enter'); };
let last = '', still = 0;
for (let i = 0; i < 90; i++) { await sleep(500); const cur = scr(); if (/A:\\>/.test(cur)) break; if (cur === last) still++; else still = 0; last = cur; if (still >= 6) { await press('Enter'); still = 0; } }
armed = true;
await type('d:'); await sleep(3000); await type('cd freedos\\bin'); await sleep(3000); await type('dir'); await sleep(4000);
mb.powerOff(); console.log = L;
console.log(`escritas em DS:0050 (0x113D0..3): ${log.length}`);
console.log(log.slice(0, 40).join('\n')); console.log('mem 113D0 (DS:0050) final =', [0,1,2,3].map((i)=>hx(mem.read8(0x113D0+i))).join(' ')); console.log('--- contexto antes do primeiro ROL EAX,16 em 1138:052F (últimas instruções) ---'); console.log(rolCtx || '(não ocorreu)'); console.log('--- instruções que mudam a metade alta de EAX (durante a janela) ---'); console.log(hiChanges.join('\n'));
