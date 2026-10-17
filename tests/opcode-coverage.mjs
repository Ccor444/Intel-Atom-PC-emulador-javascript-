// node tests/opcode-coverage.mjs — quais opcodes (1 byte, e 0F xx) a CPU NÃO implementa (lança "não implementado").
import { Motherboard } from '../src/motherboard.js';
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });
const c = mb.cpu, m = mb.mem;
const missing1 = [], missing2 = [];
const run = (bytes) => {
  for (let i = 0; i < 8; i++) m.write8(0x100 + i, bytes[i] ?? 0x90);
  c.halted = false; c.osize = 16; c.asize = 16; c.segOvr = -1; c.rep = 0; c.ip = 0x100; c.sregs.fill(0); c.regs.fill(0);
  c.w16(4, 0x7000); c.sregs[3] = 0; c.sregs[0] = 0; c.flags = 2;
  try { c.step(); return null; } catch (e) { return e.message; }
};
for (let op = 0; op < 256; op++) {
  if (op === 0x0F) continue;
  const err = run([op, 0xC0, 0x00, 0x00, 0x00, 0x00]);
  if (err && /não implementado/.test(err)) missing1.push(op.toString(16).padStart(2, '0'));
}
for (let op2 = 0; op2 < 256; op2++) {
  const err = run([0x0F, op2, 0xC0, 0x00, 0x00, 0x00]);
  if (err && /não implementado|0x0F/.test(err)) missing2.push(op2.toString(16).padStart(2, '0'));
}
console.log(`opcodes de 1 byte não implementados (${missing1.length}): ${missing1.join(' ') || '(nenhum)'}`);
console.log(`opcodes 0F xx não implementados (${missing2.length}): ${missing2.join(' ') || '(nenhum)'}`);
