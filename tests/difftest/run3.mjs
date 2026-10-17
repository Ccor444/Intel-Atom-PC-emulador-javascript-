// node run3.mjs /tmp/vec3.bin [caminho/cpu.js] — instruções de string, CPU JS vs hardware.
import fs from 'node:fs';
import { Motherboard } from '../../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });
const cpu = mb.cpu, mem = mb.mem;
const raw = fs.readFileSync(process.argv[2]); const SZ = 16 * 2 + 64 * 3;
const hx = (v, w = 4) => v.toString(16).padStart(w, '0');
const NM = { 0xA4: 'MOVS', 0xA6: 'CMPS', 0xAE: 'SCAS', 0xAC: 'LODS', 0xAA: 'STOS' }, PF = ['', 'REP ', 'REPNE '];
const stat = {}; let bad = 0; const N = raw.length / SZ;
for (let n = 0; n < N; n++) {
  const b = n * SZ, u16 = (i) => raw[b + i * 2] | (raw[b + i * 2 + 1] << 8);
  const op = u16(0), pfx = u16(1), w16 = u16(2), df = u16(3), cx = u16(4), ax = u16(5), fin = u16(6), fout = u16(7), cxo = u16(8), axo = u16(9), dsi = u16(10), ddi = u16(11);
  const src = raw.subarray(b + 32, b + 96), dst = raw.subarray(b + 96, b + 160), dsto = raw.subarray(b + 160, b + 224);
  for (let i = 0; i < 64; i++) { mem.write8(0x10000 + 0x100 + i, src[i]); mem.write8(0x20000 + 0x100 + i, dst[i]); }   // DS=1000h, ES=2000h
  const code = []; if (pfx) code.push(pfx === 1 ? 0xF3 : 0xF2); code.push(op + w16);
  for (let i = 0; i < code.length; i++) mem.write8(0x100 + i, code[i]);
  cpu.halted = false; cpu.osize = 16; cpu.asize = 16; cpu.segOvr = -1; cpu.rep = 0; cpu.ip = 0x100; cpu.sregs.fill(0); cpu.regs.fill(0);
  cpu.sregs[3] = 0x1000; cpu.sregs[0] = 0x2000; cpu.w16(0, ax); cpu.w16(1, cx); cpu.w16(6, 0x120); cpu.w16(7, 0x120); cpu.w16(4, 0x7000);
  cpu.flags = fin | 2 | (df ? 0x400 : 0);
  let err = null; try { for (let s = 0; s < 40 && cpu.ip !== 0x100 + code.length; s++) cpu.step(); } catch (e) { err = e.message; }
  const diffs = [];
  if (err) diffs.push('ERRO ' + err);
  if (cpu.ip !== 0x100 + code.length) diffs.push(`não terminou (IP=${hx(cpu.ip)})`);
  if (cpu.r16(1) !== cxo) diffs.push(`CX esperado ${cxo} obtido ${cpu.r16(1)}`);
  if (cpu.r16(0) !== axo) diffs.push(`AX esperado ${hx(axo)} obtido ${hx(cpu.r16(0))}`);
  if (((cpu.r16(6) - 0x120) & 0xFFFF) !== dsi) diffs.push(`ΔSI esperado ${(dsi << 16 >> 16)} obtido ${((cpu.r16(6) - 0x120) << 16 >> 16)}`);
  if (((cpu.r16(7) - 0x120) & 0xFFFF) !== ddi) diffs.push(`ΔDI esperado ${(ddi << 16 >> 16)} obtido ${((cpu.r16(7) - 0x120) << 16 >> 16)}`);
  if ((cpu.flags & 0x8D5) !== fout) diffs.push(`flags esperado ${hx(fout)} obtido ${hx(cpu.flags & 0x8D5)}`);
  for (let i = 0; i < 64; i++) if (mem.read8(0x20000 + 0x100 + i) !== dsto[i]) { diffs.push(`memória destino difere em +${i}`); break; }
  const key = `${PF[pfx]}${NM[op]}${w16 ? 'W' : 'B'} DF=${df}`; const s = (stat[key] ||= { n: 0, bad: 0, ex: [] }); s.n++;
  if (diffs.length) { s.bad++; bad++; if (s.ex.length < 1) s.ex.push(`CX=${cx} AX=${hx(ax)} F=${hx(fin)} → ${diffs.join('; ')}`); }
}
let okc = 0; const keys = Object.keys(stat).sort();
for (const k of keys) { const s = stat[k]; if (s.bad) { console.log(`✘ ${k.padEnd(18)} ${String(s.n).padStart(6)} testes, ${s.bad} divergências`); for (const e of s.ex) console.log('     ' + e); } else okc++; }
console.log(`\n${okc}/${keys.length} formas idênticas ao hardware; ${N} vetores; ${bad} divergências`);
