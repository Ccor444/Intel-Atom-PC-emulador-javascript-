// node run5.mjs /tmp/vec5.bin — instruções com OPERANDO DE MEMÓRIA (8/16/32 bits): CPU JS vs hardware real.
import fs from 'node:fs';
import { Motherboard } from '../../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });
const cpu = mb.cpu, mem = mb.mem;
const ALLF = 0x8D5, CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, OF = 0x800;
const raw = fs.readFileSync(process.argv[2]); const SZ = 340, N = Math.floor(raw.length / SZ);
const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
const hx = (v, w = 8) => (v >>> 0).toString(16).padStart(w, '0');
const GROUPS = new Set([0x80, 0x81, 0x83, 0xC0, 0xC1, 0xD0, 0xD1, 0xD2, 0xD3, 0xF6, 0xF7, 0xFE, 0xFF, 0xC6, 0xC7]);
const BASEREG = [6, 7, 5, 3];            // SI DI BP BX
const stat = {}; let bad = 0; const WIN = 0x10000 + 0x100, BASEOFF = 0x120;
for (let n = 0; n < N; n++) {
  const o = n * SZ, u32 = (x) => dv.getUint32(o + x, true);
  const jlen = u32(4), cls = u32(40) & 255, base = (u32(40) >> 8) & 255, cnt = u32(44), w = u32(48), fin = u32(52), fout = u32(56);
  const js = []; for (let i = 0; i < jlen; i++) js.push(raw[o + 24 + i]);
  for (let i = 0; i < jlen; i++) mem.write8(0x100 + i, js[i]);
  for (let i = 0; i < 128; i++) mem.write8(WIN + i, raw[o + 84 + i]);
  cpu.halted = false; cpu.osize = 16; cpu.asize = 16; cpu.segOvr = -1; cpu.rep = 0; cpu.ip = 0x100; cpu.sregs.fill(0); cpu.regs.fill(0);
  cpu.sregs[3] = 0x1000; cpu.sregs[0] = 0x1000; cpu.sregs[2] = 0x1000; cpu.w16(4, 0x7000);
  for (const r of [6, 7, 5, 3]) cpu.w16(r, BASEOFF);
  cpu.w32(0, u32(60)); cpu.w32(1, u32(64)); cpu.w32(2, u32(68)); cpu.flags = fin | 2;
  let err = null; try { cpu.step(); } catch (e) { err = e.message; }
  const i0 = js[0] === 0x66 ? 1 : 0; const twob = js[i0] === 0x0F;
  const opc = twob ? `0F ${hx(js[i0 + 1], 2)}` : hx(js[i0], 2);
  const modrm = js[i0 + (twob ? 2 : 1)]; const regf = (twob ? js[i0 + 1] === 0xBA : GROUPS.has(js[i0])) ? ' /' + ((modrm >> 3) & 7) : '';
  const key = `w${w} ${opc}${regf}`; const s = (stat[key] ||= { n: 0, bad: 0, ex: [] }); s.n++;
  let mask = ALLF;
  if (cls === 1) mask = ALLF & ~AF; else if (cls === 2) mask = cnt <= 1 ? ALLF : ALLF & ~OF;
  else if (cls === 3) mask = cnt === 0 ? ALLF : (CF | PF | ZF | SF | (cnt === 1 ? OF : 0));
  else if (cls === 4) mask = CF | OF; else if (cls === 5) mask = cnt === 0 ? ALLF : (CF | PF | ZF | SF | (cnt === 1 ? OF : 0)); else if (cls === 6) mask = CF;
  const d = [];
  if (err) d.push('ERRO ' + err);
  else {
    if (cpu.ip - 0x100 !== jlen) d.push(`tamanho ${cpu.ip - 0x100}≠${jlen}`);
    for (let i = 0; i < 3; i++) if (cpu.r32(i === 0 ? 0 : i === 1 ? 1 : 2) >>> 0 !== u32(72 + i * 4)) d.push(`${['EAX', 'ECX', 'EDX'][i]}: esperado ${hx(u32(72 + i * 4))} obtido ${hx(cpu.r32(i))}`);
    for (let i = 0; i < 128; i++) if (mem.read8(WIN + i) !== raw[o + 212 + i]) { d.push(`memória +${i - 32}: esperado ${hx(raw[o + 212 + i], 2)} obtido ${hx(mem.read8(WIN + i), 2)} (inicial ${hx(raw[o + 84 + i], 2)})`); break; }
    if (((cpu.flags ^ fout) & mask) !== 0) d.push(`flags: esperado ${hx(fout & mask, 4)} obtido ${hx(cpu.flags & mask, 4)}`);
  }
  if (d.length) { s.bad++; bad++; if (s.ex.length < 2) s.ex.push(`[${js.map((b) => hx(b, 2)).join(' ')}] base=${['SI', 'DI', 'BP', 'BX'][base]} EAX=${hx(u32(60))} cnt=${cnt} → ${d.slice(0, 3).join('; ')}`); }
}
const keys = Object.keys(stat).sort(); let okc = 0;
for (const k of keys) { const s = stat[k]; if (s.bad) { console.log(`✘ ${k.padEnd(14)} ${String(s.n).padStart(6)} testes, ${s.bad} divergências`); for (const e of s.ex) console.log('     ' + e); } else okc++; }
console.log(`\n${okc}/${keys.length} formas idênticas ao hardware; ${N} vetores; ${bad} divergências`);
