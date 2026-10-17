// node boot-real.mjs [segundos=10] [--iso]  — boot REAL: GLaBIOS + disks/FD14BOOT.img (+ ISO opcional)
import fs from 'node:fs';
import { Motherboard } from '../src/motherboard.js';
import { loadCdFromFile } from '../src/cdrom.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const secs = Number(process.argv[2]) || 10, useIso = process.argv.includes('--iso');
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16, hddMB: 4 });
mb.setBIOSBinary(new Uint8Array(fs.readFileSync('roms/GLABIOS_0.4.2_8P.ROM')));
mb.loadDiskImage(0, new Uint8Array(fs.readFileSync('disks/FD14BOOT.img')));
if (useIso) mb.loadCdImage(await loadCdFromFile(await fs.openAsBlob('disks/FD14LIVE.iso')));
const L = console.log, W = console.warn, E = console.error; const logs = [];
console.log = () => {}; console.warn = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push('ERR ' + a.join(' '));
mb.powerOn();
const t0 = performance.now(); const ips = new Map(); let lastIp = '';
const iv = setInterval(() => { const k = mb.loopStatus().ip; ips.set(k, (ips.get(k) || 0) + 1); }, 20);
await new Promise((r) => setTimeout(r, secs * 1000)); clearInterval(iv); mb.powerOff(); console.log = L;
const CP = (c) => c >= 32 && c < 127 ? String.fromCharCode(c) : c === 0 ? ' ' : (c >= 0xB0 && c <= 0xDF) ? '#' : '·';
const screen = () => { let o = ''; for (let y = 0; y < 25; y++) { let s = ''; for (let x = 0; x < 80; x++) { const c = mb.mem.read8(0xB8000 + (y * 80 + x) * 2); s += CP(c); } if (s.trim()) o += '|' + s.trimEnd() + '\n'; } return o; };
console.log(screen()); const st = mb.loopStatus(); const cp = mb.vga.cursorPos; console.log(`cursor: linha ${Math.floor(cp / 80)} coluna ${cp % 80}`);
console.log(`IP final ${st.ip}  halted=${mb.cpu.halted}  ciclos=${mb.cycleCount.toLocaleString()}  erros do loop=${mb._loopErrors}  (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
console.log('IPs mais amostrados:', [...ips.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`).join('  '));
const lg = (mb.int13Log || []); console.log(`INT 13h: ${lg.length} chamadas; erros: ${lg.filter((e) => e.status && e.dl < 0x80).length}; últimas:`);
for (const e of lg.slice(-6)) console.log(`   AH=${e.ah.toString(16)} AL=${e.al} CHS=${e.cyl}/${e.head}/${e.sec} DL=${e.dl} ES:BX=${e.es.toString(16)}:${e.bx.toString(16)} → ${e.status ? '0x' + e.status.toString(16) : 'ok'}`);
const interesting = logs.filter((l) => !l.startsWith('[BIOS]') && !l.startsWith('[MB]')); if (interesting.length) console.log('avisos/erros:\n  ' + interesting.slice(0, 12).join('\n  '));
if (process.argv.includes('--dump')) { const hx = (v) => v.toString(16).padStart(2, '0');
  for (const y of [0, 1, 2, 3, 4]) { let a = ''; for (let x = 16; x < 40; x++) a += hx(mb.mem.read8(0xB8000 + (y * 80 + x) * 2)) + '/' + hx(mb.mem.read8(0xB8000 + (y * 80 + x) * 2 + 1)) + ' '; console.log(`linha ${y} cols 16-39 (char/attr): ${a}`); }
  console.log('modo/CRTC: vga.mode?', mb.vga.mode, ' BDA 0x449 (modo)=', mb.mem.read8(0x449), ' colunas 0x44A=', mb.mem.read16(0x44A), ' página base 0x44E=', mb.mem.read16(0x44E).toString(16)); }
