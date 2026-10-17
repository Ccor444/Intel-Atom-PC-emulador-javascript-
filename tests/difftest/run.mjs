// node run.mjs /tmp/vec.bin  — compara a CPU JS com resultados do hardware real (ALU, shifts, MUL/DIV).
import fs from 'node:fs';
import { Motherboard } from '../../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });
const cpu = mb.cpu, mem = mb.mem;
const NAMES = ['ADD','OR','ADC','SBB','AND','SUB','XOR','CMP','TEST','INC','DEC','NEG','NOT','ROL','ROR','RCL','RCR','SHL','SHR','SAR','MUL','IMUL','DIV','IDIV'];
const [ADD,OR,ADC,SBB,AND,SUB,XOR,CMP,TEST,INC,DEC,NEG,NOT,ROL,ROR,RCL,RCR,SHL,SHR,SAR,MUL,IMUL,DIV,IDIV] = NAMES.map((_, i) => i);
const ALU_BASE = { [ADD]: 0x00, [OR]: 0x08, [ADC]: 0x10, [SBB]: 0x18, [AND]: 0x20, [SUB]: 0x28, [XOR]: 0x30, [CMP]: 0x38, [TEST]: 0x84 };
const SHREG = { [ROL]: 0, [ROR]: 1, [RCL]: 2, [RCR]: 3, [SHL]: 4, [SHR]: 5, [SAR]: 7 };
const MULREG = { [MUL]: 4, [IMUL]: 5, [DIV]: 6, [IDIV]: 7 };
const ALLF = 0x8D5, CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, OF = 0x800;

const raw = fs.readFileSync(process.argv[2]);
const V = new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
const N = V.length / 8;
const stat = {}; const hex = (v, w = 4) => v.toString(16).padStart(w, '0');
const t0 = performance.now();

for (let n = 0; n < N; n++) {
  const o = n * 8, op = V[o] & 255, w = V[o] >> 8, a = V[o + 1], b = V[o + 2], cnt = V[o + 3], fin = V[o + 4], res = V[o + 5], fo = V[o + 6], aux = V[o + 7];
  let code; const w8 = w === 8;
  if (op in ALU_BASE) code = [ALU_BASE[op] + (w8 ? 0 : 1), 0xD8];
  else if (op === INC) code = w8 ? [0xFE, 0xC0] : (a & 1 ? [0xFF, 0xC0] : [0x40]);
  else if (op === DEC) code = w8 ? [0xFE, 0xC8] : (a & 1 ? [0xFF, 0xC8] : [0x48]);
  else if (op === NEG) code = [w8 ? 0xF6 : 0xF7, 0xD8];
  else if (op === NOT) code = [w8 ? 0xF6 : 0xF7, 0xD0];
  else if (op in SHREG) code = [(cnt === 1 && (a & 1) ? 0xD0 : 0xD2) + (w8 ? 0 : 1), 0xC0 | (SHREG[op] << 3)];
  else code = [w8 ? 0xF6 : 0xF7, 0xC0 | (MULREG[op] << 3) | 3];
  for (let i = 0; i < code.length; i++) mem.write8(0x100 + i, code[i]);

  cpu.halted = false; cpu.osize = 16; cpu.asize = 16; cpu.segOvr = -1; cpu.rep = 0; cpu.ip = 0x100; cpu.sregs.fill(0);
  cpu.regs.fill(0); cpu.flags = fin | 2;
  if (op >= MUL) { cpu.w16(0, a); cpu.w16(3, b); cpu.w16(2, op >= DIV ? cnt : 0); }
  else if (op in SHREG) { if (w8) cpu.w8(0, a); else cpu.w16(0, a); cpu.w8(1, cnt); }
  else { if (w8) { cpu.w8(0, a); cpu.w8(3, b); } else { cpu.w16(0, a); cpu.w16(3, b); } }
  let err = null; try { cpu.step(); } catch (e) { err = e.message; }

  const gotRes = op >= MUL ? cpu.r16(0) : (w8 ? cpu.r8(0) : cpu.r16(0));
  const gotAux = op >= MUL && !w8 ? cpu.r16(2) : 0;
  const gotF = cpu.flags & ALLF;
  let mask;
  if (op === ADD || op === ADC || op === SBB || op === SUB || op === CMP) mask = ALLF;
  else if (op === AND || op === OR || op === XOR || op === TEST) mask = ALLF & ~AF;
  else if (op >= INC && op <= NOT) mask = ALLF;
  else if (op <= RCR) mask = cnt === 0 ? ALLF : (cnt === 1 ? ALLF : ALLF & ~OF);
  else if (op <= SAR) mask = cnt === 0 ? ALLF : (CF | PF | ZF | SF | (cnt === 1 ? OF : 0));
  else if (op === MUL || op === IMUL) mask = CF | OF; else mask = 0;
  // MUL/IMUL 8 bits: AX inteiro é o resultado; 16 bits: AX e DX
  const resOk = op >= MUL ? (gotRes === res && (w8 || gotAux === aux)) : gotRes === res;
  const fOk = ((gotF ^ fo) & mask) === 0;
  const key = `${NAMES[op]}${w}`; const s = (stat[key] ||= { n: 0, badRes: 0, badFlags: 0, ex: [] });
  s.n++;
  if (err || !resOk || !fOk) {
    if (err || !resOk) s.badRes++; if (!err && resOk && !fOk) s.badFlags++;
    if (s.ex.length < 3) s.ex.push(err ? `ERRO ${err} a=${hex(a)} b=${hex(b)}` :
      `a=${hex(a)} b=${hex(b)} cnt=${cnt} CFin=${fin & 1} finF=${hex(fin)} | esperado res=${hex(res)}${op >= MUL && !w8 ? ':' + hex(aux) : ''} F=${hex(fo & mask)} | obtido res=${hex(gotRes)}${op >= MUL && !w8 ? ':' + hex(gotAux) : ''} F=${hex(gotF & mask)} (dif flags: ${hex((gotF ^ fo) & mask)})`);
  }
}
const dt = ((performance.now() - t0) / 1000).toFixed(1);
let bad = 0;
for (const [k, s] of Object.entries(stat)) { const b2 = s.badRes + s.badFlags; bad += b2;
  console.log(`${b2 ? '✘' : '✔'} ${k.padEnd(7)} ${String(s.n).padStart(8)} vetores  resultado errado: ${s.badRes}  flags erradas: ${s.badFlags}`);
  for (const e of s.ex) console.log('      ' + e); }
console.log(`\n${N} vetores em ${dt} s — ${bad ? bad + ' divergências' : 'CPU idêntica ao hardware'}`);
