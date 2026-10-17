// node run2.mjs /tmp/vec2.bin — CPU JS vs hardware real, operandos em registrador (inclui AH/CH/DH/BH).
import fs from 'node:fs';
import { Motherboard } from '../../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });
const cpu = mb.cpu, mem = mb.mem;
const ALLF = 0x8D5, CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, OF = 0x800;
const raw = fs.readFileSync(process.argv[2]);
const V = new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
const N = V.length / 24, IDX = [0, 1, 2, 3, 5, 6, 7], NM = ['AX','CX','DX','BX','BP','SI','DI'];
const hx = (v, w = 4) => v.toString(16).padStart(w, '0');
const GROUPS = new Set([0x80, 0x81, 0x83, 0xC0, 0xC1, 0xD0, 0xD1, 0xD2, 0xD3, 0xF6, 0xF7, 0xFE, 0xFF]);
const stat = {}; let bad = 0;
for (let n = 0; n < N; n++) {
  const o = n * 24, len = V[o], w16 = V[o + 1], cls = V[o + 5], cnt = V[o + 22];
  const code = []; for (let i = 0; i < len; i++) code.push((V[o + 2 + (i >> 1)] >> ((i & 1) * 8)) & 255);
  for (let i = 0; i < len; i++) mem.write8(0x100 + i, code[i]);
  cpu.halted = false; cpu.osize = 16; cpu.asize = 16; cpu.segOvr = -1; cpu.rep = 0; cpu.ip = 0x100; cpu.sregs.fill(0); cpu.regs.fill(0);
  for (let i = 0; i < 7; i++) cpu.w16(IDX[i], V[o + 6 + i]); cpu.w16(4, 0x7000);
  cpu.flags = V[o + 13] | 2;
  let err = null; try { cpu.step(); } catch (e) { err = e.message; }
  const op = code[0] === 0x0F ? `0F ${hx(code[1], 2)}` : hx(code[0], 2);
  const regf = code[0] === 0x0F ? '' : GROUPS.has(code[0]) ? ' /' + ((code[1] >> 3) & 7) : '';
  const key = op + regf + (w16 ? ' w16' : ' w8'); const s = (stat[key] ||= { n: 0, bad: 0, ex: [] }); s.n++;
  const w = w16 ? 16 : 8; let mask = ALLF;
  if (cls === 1) mask = ALLF & ~AF;
  else if (cls === 2) mask = cnt === 0 ? ALLF : (cnt === 1 ? ALLF : ALLF & ~OF);
  else if (cls === 3) mask = cnt === 0 ? ALLF : cnt >= w ? 0 : (CF | PF | ZF | SF | (cnt === 1 ? OF : 0));
  else if (cls === 4) mask = CF | OF;
  if ((code[0] === 0x69 || code[0] === 0x6B || (code[0] === 0x0F && code[1] === 0xAF))) mask = CF | OF;
  const diffs = [];
  if (err) diffs.push('ERRO ' + err);
  else {
    if (cpu.ip - 0x100 !== len) diffs.push(`tamanho decodificado ${cpu.ip - 0x100} ≠ ${len}`);
    for (let i = 0; i < 7; i++) if (cpu.r16(IDX[i]) !== V[o + 14 + i]) diffs.push(`${NM[i]}: esperado ${hx(V[o + 14 + i])} obtido ${hx(cpu.r16(IDX[i]))}`);
    if (cpu.r16(4) !== 0x7000) diffs.push(`SP mudou para ${hx(cpu.r16(4))}`);
    if (((cpu.flags ^ V[o + 21]) & mask) !== 0) diffs.push(`flags: esperado ${hx(V[o + 21] & mask)} obtido ${hx(cpu.flags & mask)} (máscara ${hx(mask)})`);
  }
  if (diffs.length) { s.bad++; bad++; if (s.ex.length < 2) s.ex.push(`[${code.map((b) => hx(b, 2)).join(' ')}] in: ${Array.from({ length: 7 }, (_, i) => NM[i] + '=' + hx(V[o + 6 + i])).join(' ')} F=${hx(V[o + 13])} cnt=${cnt} → ${diffs.join('; ')}`); }
}
const keys = Object.keys(stat).sort(); let okc = 0;
for (const k of keys) { const s = stat[k]; if (s.bad) { console.log(`✘ ${k.padEnd(16)} ${String(s.n).padStart(7)} testes, ${s.bad} divergências`); for (const e of s.ex) console.log('     ' + e); } else okc++; }
console.log(`\n${okc}/${keys.length} formas idênticas ao hardware; ${N} vetores; ${bad} divergências`);
