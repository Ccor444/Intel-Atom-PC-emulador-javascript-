// node tests/boot-real-check.mjs — mede quanto do boot é emulação de hardware e quanto é serviço em JavaScript (HLE).
import fs from 'node:fs';
import { Motherboard } from '../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16, hddMB: 4 });
mb.setBIOSBinary(new Uint8Array(fs.readFileSync('roms/GLABIOS_0.4.2_8P.ROM')));
const IMG = new Uint8Array(fs.readFileSync('disks/FD14BOOT.img'));
{ const pat = Buffer.from('CALL SETUP.BAT floppy'), rep = Buffer.from('REM  SETUP.BAT floppy'); const b = Buffer.from(IMG.buffer, IMG.byteOffset, IMG.length); let i = -1; while ((i = b.indexOf(pat, i + 1)) >= 0) rep.copy(b, i); }
mb.loadDiskImage(0, IMG);
const hle = { int13_js: 0, xms: 0, int15: 0, int2f: 0, int4b: 0 };
const fdcOps = {}; const fe = mb.fdc._execute.bind(mb.fdc); mb.fdc._execute = () => { const op = mb.fdc.cmd[0] & 0x1F; fdcOps[op.toString(16)] = (fdcOps[op.toString(16)] || 0) + 1; return fe(); };
const o13 = mb._int13.bind(mb); mb._int13 = () => { hle.int13_js++; return o13(); };
const ox = mb.xms.call.bind(mb.xms); mb.xms.call = () => { hle.xms++; return ox(); };
const o15 = mb.xms.int15.bind(mb.xms); mb.xms.int15 = () => { hle.int15++; return o15(); };
const o2f = mb.xms.int2f.bind(mb.xms); mb.xms.int2f = () => { hle.int2f++; return o2f(); };
const o4b = mb.xms.int4b.bind(mb.xms); mb.xms.int4b = () => { hle.int4b++; return o4b(); };
// quantas instruções executam dentro do código da ROM (segmento F000 / FE00-FFFF) versus o resto
let romSteps = 0, totalSteps = 0; const cpu = mb.cpu, os = cpu.step.bind(cpu);
cpu.step = () => { totalSteps++; if (cpu.sregs[1] >= 0xE000) romSteps++; return os(); };
const L = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
mb.powerOn();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scr = () => { let o = ''; for (let k = 0; k < 2000; k++) o += String.fromCharCode(mb.mem.read8(0xB8000 + k * 2) || 32); return o; };
const press = async (c) => { mb.kbd.keyDown(c); await sleep(110); mb.kbd.keyUp(c); await sleep(90); };
let ok = false, last = '', still = 0;
for (let i = 0; i < 90 && !ok; i++) { await sleep(500); const cur = scr(); ok = /A:\\>/.test(cur); if (cur === last) still++; else still = 0; last = cur; if (!ok && still >= 6) { await press('Enter'); still = 0; } }
mb.powerOff(); console.log = L;
const pct = (n) => (100 * n / Math.max(1, totalSteps)).toFixed(1);
console.log(`prompt A:\\> alcançado: ${ok}`);
console.log(`instruções executadas: ${totalSteps.toLocaleString()}; dentro do código da ROM (≥E000): ${romSteps.toLocaleString()} (${pct(romSteps)}%)`);
console.log(`serviços tratados em JavaScript (não pelo código da ROM):`);
console.log(`  INT 13h (disco, em JS)    : ${hle.int13_js}  ${mb.hleDisk ? '(hleDisk ligado)' : '(hleDisk desligado: ROM real)'}`);
console.log(`  comandos no µPD765 real   : ${JSON.stringify(fdcOps)}  (op: contagem)`);
console.log(`  INT 2Fh (XMS detect)      : ${hle.int2f}`);
console.log(`  XMS 3.0 (todas as funções): ${hle.xms}`);
console.log(`  INT 15h estendido         : ${hle.int15}`);
console.log(`  INT 4Bh (VDS)             : ${hle.int4b}`);
// veredito: o boot só conta como "real" se o prompt aparece, o INT 13h do disco não foi atendido em JS e o
// controlador µPD765 executou leituras de verdade
const diskReal = hle.int13_js === 0 && !mb.hleDisk && (fdcOps['6'] || 0) > 0;
console.log(ok && diskReal ? '\n✔ boot real: disco lido pelo µPD765 e pela ROM (sem INT 13h em JavaScript)' : '\n✘ boot real falhou');
process.exit(ok && diskReal ? 0 : 1);

