// node run4.mjs /tmp/vec4.bin — instruções de 32 BITS (prefixo 66h em modo real): CPU JS vs hardware real.
import fs from 'node:fs';
import { Motherboard } from '../../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });
const cpu = mb.cpu, mem = mb.mem;
const ALLF = 0x8D5, CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, OF = 0x800;
const raw = fs.readFileSync(process.argv[2]);
const V = new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
const N = V.length / 24, IDX = [0, 1, 2, 3, 5, 6, 7], NM = ['EAX','ECX','EDX','EBX','EBP','ESI','EDI'];
const hx = (v, w = 8) => (v >>> 0).toString(16).padStart(w, '0');
const GROUPS = new Set([0x81, 0x83, 0xC1, 0xD1, 0xD3, 0xF7, 0xFF, 0xBA]);
const stat = {}; let bad = 0;
for (let n = 0; n < N; n++) {
  const o = n * 24, len = V[o], cls = V[o + 4], cnt = V[o + 5];
  const code = [0x66]; for (let i = 0; i < len; i++) code.push((V[o + 1 + (i >> 2)] >>> ((i & 3) * 8)) & 255);
  for (let i = 0; i < code.length; i++) mem.write8(0x100 + i, code[i]);
  cpu.halted = false; cpu.osize = 16; cpu.asize = 16; cpu.segOvr = -1; cpu.rep = 0; cpu.ip = 0x100; cpu.sregs.fill(0); cpu.regs.fill(0);
  for (let i = 0; i < 7; i++) cpu.w32(IDX[i], V[o + 8 + i]); cpu.w16(4, 0x7000);
  cpu.flags = V[o + 6] | 2;
  let err = null; try { cpu.step(); } catch (e) { err = e.message; }
  const c1 = code[1], twob = c1 === 0x0F;
  const op = twob ? `0F ${hx(code[2], 2)}` : hx(c1, 2);
  const regf = (twob ? code[2] === 0xBA : GROUPS.has(c1)) ? ' /' + (((twob ? code[3] : code[2]) >> 3) & 7) : '';
  const key = op + regf; const s = (stat[key] ||= { n: 0, bad: 0, ex: [] }); s.n++;
  let mask = ALLF;
  if (cls === 1) mask = ALLF & ~AF;
  else if (cls === 2) mask = cnt <= 1 ? ALLF : ALLF & ~OF;
  else if (cls === 3) mask = cnt === 0 ? ALLF : (CF | PF | ZF | SF | (cnt === 1 ? OF : 0));
  else if (cls === 4) mask = CF | OF;
  else if (cls === 5) mask = cnt === 0 ? ALLF : (CF | PF | ZF | SF | (cnt === 1 ? OF : 0));
  else if (cls === 6) mask = CF;
  else if (cls === 7) mask = ZF;
  const diffs = [];
  if (err) diffs.push('ERRO ' + err);
  else {
    if (cpu.ip - 0x100 !== code.length) diffs.push(`tamanho decodificado ${cpu.ip - 0x100} ≠ ${code.length}`);
    for (let i = 0; i < 7; i++) if (cpu.r32(IDX[i]) >>> 0 !== V[o + 15 + i]) diffs.push(`${NM[i]}: esperado ${hx(V[o + 15 + i])} obtido ${hx(cpu.r32(IDX[i]))}`);
    if (cpu.r16(4) !== 0x7000) diffs.push(`SP mudou`);
    if (((cpu.flags ^ V[o + 7]) & mask) !== 0) diffs.push(`flags: esperado ${hx(V[o + 7] & mask, 4)} obtido ${hx(cpu.flags & mask, 4)} (máscara ${hx(mask, 4)})`);
  }
  if (diffs.length) { s.bad++; bad++; if (s.ex.length < 2) s.ex.push(`[${code.slice(1).map((b) => hx(b, 2)).join(' ')}] in: ${Array.from({ length: 7 }, (_, i) => NM[i] + '=' + hx(V[o + 8 + i])).join(' ')} F=${hx(V[o + 6], 3)} cnt=${cnt} → ${diffs.slice(0, 3).join('; ')}`); }
}
const keys = Object.keys(stat).sort(); let okc = 0;
for (const k of keys) { const s = stat[k]; if (s.bad) { console.log(`✘ ${k.padEnd(12)} ${String(s.n).padStart(7)} testes, ${s.bad} divergências`); for (const e of s.ex) console.log('     ' + e); } else okc++; }
console.log(`\n${okc}/${keys.length} formas idênticas ao hardware; ${N} vetores; ${bad} divergências`);
