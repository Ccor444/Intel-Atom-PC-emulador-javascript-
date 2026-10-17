// node ctrl-flow-test.mjs — saltos/chamadas INDIRETOS (Group 5, opcode FF) com operando de memória.
// Regressão: JMP FAR [mem] (FF /5) não existia e CALL FAR [mem] (FF /3) não carregava o CS — era o que
// impedia o setor de boot do FreeDOS de saltar ao kernel.
import { Motherboard } from '../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });
const c = mb.cpu, mem = mb.mem; let fails = 0;
const ok = (cond, m) => { console.log(`${cond ? '✔' : '✘'} ${m}`); if (!cond) fails++; };
const hx = (v) => v.toString(16);
const setup = (code, { bp = 0, ss = 0, ds = 0, sp = 0x7000 } = {}) => {
  for (let i = 0; i < code.length; i++) mem.write8(0x100 + i, code[i]);
  c.halted = false; c.osize = 16; c.asize = 16; c.segOvr = -1; c.rep = 0; c.sregs.fill(0); c.regs.fill(0);
  c.sregs[3] = ds; c.sregs[2] = ss; c.w16(4, sp); c.w16(5, bp); c.ip = 0x100;
};
mem.write16(0x200, 0x1234); mem.write16(0x202, 0x5678);

setup([0xFF, 0x2E, 0x00, 0x02]); c.step();                      // JMP FAR [0200]
ok(c.sregs[1] === 0x5678 && c.ip === 0x1234 && c.r16(4) === 0x7000, `JMP FAR [mem]: CS:IP=${hx(c.sregs[1])}:${hx(c.ip)} (esperado 5678:1234), SP intacto`);

setup([0xFF, 0x1E, 0x00, 0x02]); c.step();                      // CALL FAR [0200]
const sp = c.r16(4);
ok(c.sregs[1] === 0x5678 && c.ip === 0x1234 && sp === 0x7000 - 4, `CALL FAR [mem]: CS:IP=${hx(c.sregs[1])}:${hx(c.ip)}, SP=${hx(sp)}`);
ok(mem.read16(sp) === 0x104 && mem.read16(sp + 2) === 0x0000, `CALL FAR empilhou IP de retorno ${hx(mem.read16(sp))} e CS antigo ${hx(mem.read16(sp + 2))}`);
mem.write8((0x5678 << 4) + 0x1234, 0xCB); c.step();             // RETF no destino
ok(c.sregs[1] === 0 && c.ip === 0x104 && c.r16(4) === 0x7000, `RETF volta a ${hx(c.sregs[1])}:${hx(c.ip)} com SP restaurado`);

// o caso exato do setor de boot do FreeDOS: ljmp *0x5a(%bp) com SS=DS=1FE0, BP=7C00, ponteiro 0060:0000
const ss = 0x1FE0, base = (ss << 4) + 0x7C5A; mem.write16(base, 0x0000); mem.write16(base + 2, 0x0060);
setup([0xFF, 0x6E, 0x5A], { bp: 0x7C00, ss, ds: ss, sp: 0x7BA0 }); c.step();
ok(c.sregs[1] === 0x0060 && c.ip === 0x0000, `ljmp *0x5a(%bp) (FreeDOS): CS:IP=${hx(c.sregs[1])}:${hx(c.ip)} (esperado 0060:0000)`);

setup([0xFF, 0x26, 0x00, 0x02]); mem.write16(0x200, 0x4321); c.step();   // JMP near [mem]
ok(c.ip === 0x4321 && c.sregs[1] === 0, `JMP near [mem]: IP=${hx(c.ip)}`);
setup([0xFF, 0x16, 0x00, 0x02]); c.step();                               // CALL near [mem]
ok(c.ip === 0x4321 && mem.read16(c.r16(4)) === 0x104, `CALL near [mem]: IP=${hx(c.ip)}, retorno ${hx(mem.read16(c.r16(4)))}`);
setup([0xFF, 0xE3]); c.w16(3, 0x2222); c.step(); ok(c.ip === 0x2222, `JMP BX: IP=${hx(c.ip)}`);
setup([0xFF, 0xD3]); c.w16(3, 0x3333); c.step(); ok(c.ip === 0x3333 && mem.read16(c.r16(4)) === 0x102, `CALL BX: IP=${hx(c.ip)}`);
// FF EB = JMP FAR com operando de registrador: #UD → a CPU entrega INT 6 com o IP da instrução (0100h)
{ let got = null; c.intHandler = function (vec) { got = { vec, ip: this.ip }; };
  setup([0xFF, 0xEB]); c.step(); c.intHandler = null;
  ok(got && got.vec === 6 && got.ip === 0x100, `JMP FAR com registrador (FF EB) → #UD: INT 6 com IP da instrução (${got ? got.vec + ' @' + hx(got.ip) : 'nada'})`); }
console.log(fails ? `\n✘ ${fails} falha(s)` : '\n✔ saltos/chamadas indiretos: todos os testes passaram'); process.exit(fails ? 1 : 0);
