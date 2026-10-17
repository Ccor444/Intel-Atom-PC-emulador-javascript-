// node tests/hi16-preserve.mjs — operações de 16 bits (sem prefixo 66h) NÃO podem alterar a metade alta de EAX/ECX/EDX/EBX/ESI/EDI.
import { Motherboard } from '../src/motherboard.js';
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });
const c = mb.cpu, m = mb.mem; let fails = 0;
const hx = (v) => (v >>> 0).toString(16).padStart(8, '0');
const run = (bytes, setup) => {
  for (let i = 0; i < bytes.length; i++) m.write8(0x100 + i, bytes[i]);
  c.halted = false; c.osize = 16; c.asize = 16; c.segOvr = -1; c.rep = 0; c.ip = 0x100;
  c.sregs.fill(0); c.regs.fill(0); c.w16(4, 0x7000); c.sregs[3] = 0; c.sregs[0] = 0; c.flags = 2;
  for (const r of [0,1,2,3,5,6,7]) c.w32(r, 0xABCD0000 | r);            // metade alta marcada
  setup(); c.step();
};
const cases = [
  ['mov ax,imm16 (B8)', [0xB8,0x34,0x12], () => {}, 0],
  ['mov cx,imm16 (B9)', [0xB9,0x34,0x12], () => {}, 1],
  ['mov ax,[bx] (8B 07)', [0x8B,0x07], () => { c.w16(3, 0x200); m.write16(0x200, 0x5555); }, 0],
  ['add ax,imm (05)', [0x05,0x01,0x00], () => {}, 0],
  ['add ax,bx (01 D8)', [0x01,0xD8], () => { c.w16(3, 7); }, 0],
  ['sub cx,1 (83 E9 01)', [0x83,0xE9,0x01], () => {}, 1],
  ['inc ax (40)', [0x40], () => {}, 0],
  ['dec bx (4B)', [0x4B], () => {}, 3],
  ['inc di (47)', [0x47], () => {}, 7],
  ['push ax (50)', [0x50], () => {}, 0],
  ['pop cx (59)', [0x59], () => { m.write16(0x6FFE, 0x4444); }, 1],
  ['xchg ax,dx (92)', [0x92], () => {}, 0],
  ['lodsw (AD)', [0xAD], () => { c.w16(6, 0x200); m.write16(0x200, 0x6666); }, 0],
  ['stosw (AB)', [0xAB], () => { c.w16(7, 0x300); }, 0],
  ['mov ax,dx (89 D0)', [0x89,0xD0], () => {}, 0],
  ['shl ax,1 (D1 E0)', [0xD1,0xE0], () => {}, 0],
  ['and ax,0x00FF (25 FF 00)', [0x25,0xFF,0x00], () => {}, 0],
  ['pop ds / mov es,ax (8E C0)', [0x8E,0xC0], () => {}, 0],
  ['lea ax,[bx+2] (8D 47 02)', [0x8D,0x47,0x02], () => { c.w16(3, 0x100); }, 0],
  ['movzx ... (mov ax,word[di+2]) 8B 45 02', [0x8B,0x45,0x02], () => { c.w16(7, 0x200); m.write16(0x202, 0x7777); }, 0],
  ['adc ax,0 (83 D0 00)', [0x83,0xD0,0x00], () => {}, 0],
  ['cmp ax,1 (3D 01 00)', [0x3D,0x01,0x00], () => {}, 0],
  ['in ax,dx (ED)', [0xED], () => { c.w16(2, 0x300); }, 0],
  ['mov word[bx],ax (89 07)', [0x89,0x07], () => { c.w16(3, 0x400); }, 0],
];
for (const [name, bytes, setup, reg] of cases) {
  run(bytes, setup);
  const hi = (c.r32(reg) >>> 16) & 0xFFFF, want = 0xABCD;
  const hiAll = [0,1,2,3,5,6,7].filter((r) => r !== reg && (c.r32(r) >>> 16) !== (0xABCD)).map((r) => r);
  const bad = (reg !== undefined && hi !== want) || hiAll.length;
  if (bad) fails++;
  console.log(`${bad ? '✘' : '✔'} ${name.padEnd(42)} reg=${['EAX','ECX','EDX','EBX','ESP','EBP','ESI','EDI'][reg]} → ${hx(c.r32(reg))}${hiAll.length ? '  (outras metades alteradas: ' + hiAll.map((r) => hx(c.r32(r))).join(' ') + ')' : ''}`);
}
console.log(fails ? `\n✘ ${fails} operação(ões) de 16 bits alteram a metade alta` : '\n✔ operações de 16 bits preservam a metade alta');
process.exit(fails ? 1 : 0);
