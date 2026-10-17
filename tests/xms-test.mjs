// node xms-test.mjs [roms/GLABIOS_0.4.2_8P.ROM]
// XMS 3.0 / VDS / INT 15h estendido (src/xms.js): testes unitários + um boot sector que usa o driver pela
// CPU emulada (INT 2Fh 4300h/4310h, CALL FAR [entrada], INT 15h AH=88h, INT 4Bh AX=8103h) na GLaBIOS real.
import fs from 'node:fs';
import { Motherboard } from '../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
let fails = 0; const ok = (c, m) => { console.log(`${c ? '  ✔' : '  ✘'} ${m}`); if (!c) fails++; };
const romPath = process.argv[2] || 'roms/GLABIOS_0.4.2_8P.ROM';
const mk = () => new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });

console.log('[1] XMS: alocador, mover, lock, erros');
{
  const mb = mk(), c = mb.cpu, x = mb.xms; x.reset();
  const call = (ah, regs = {}) => { c.w16(0, ah << 8); if ('dx' in regs) c.w16(2, regs.dx); if ('bx' in regs) c.w16(3, regs.bx); x.call(); return { ax: c.r16(0), bl: c.r8(3), dx: c.r16(2), bx: c.r16(3) }; };
  ok(call(0x00).ax === 0x0300 && c.r16(2) === 0, 'versão 3.00, sem HMA');
  ok(call(0x01).ax === 0 && c.r8(3) === 0x90, 'pedir HMA → erro 90h (não existe)');
  const free0 = call(0x08).ax; ok(free0 === 15360, `livre = ${free0} KB (16 MB − 1 MB)`);
  const a = call(0x09, { dx: 1024 }), b = call(0x09, { dx: 2048 }), d = call(0x09, { dx: 512 });
  ok(a.ax === 1 && b.ax === 1 && d.ax === 1 && new Set([a.dx, b.dx, d.dx]).size === 3, `3 blocos alocados (handles ${a.dx},${b.dx},${d.dx})`);
  ok(call(0x08).ax === 15360 - 3584 && c.r16(2) === 15360 - 3584, 'livre diminui 3584 KB');
  ok(call(0x0A, { dx: b.dx }).ax === 1, 'liberar o bloco do meio');
  ok(call(0x09, { dx: 3000 }).ax === 1, 'bloco de 3000 KB cabe depois do maior buraco (no fim)');
  const huge = call(0x09, { dx: 60000 }); ok(huge.ax === 0 && huge.bl === 0xA0, 'alocar 60000 KB → A0h (sem memória)');
  const lk = call(0x0C, { dx: a.dx }); ok(lk.ax === 1 && ((lk.dx << 16) | lk.bx) === 0x100000, `travar → endereço linear ${(((lk.dx << 16) | lk.bx) >>> 0).toString(16)}`);
  ok(call(0x0A, { dx: a.dx }).bl === 0xAB, 'liberar bloco travado → ABh');
  ok(call(0x0D, { dx: a.dx }).ax === 1 && call(0x0A, { dx: a.dx }).ax === 1, 'destravar e liberar');
  ok(call(0x0A, { dx: 0x7777 }).bl === 0xA2, 'handle inválido → A2h');
  const info = call(0x0E, { dx: d.dx }); ok(info.ax === 1 && info.dx === 512, 'informações do handle: 512 KB');
  // mover: conv → EMB → EMB (sobreposto) → conv
  const SRC = 0x9000, DST = 0xA000, m = mb.mem; for (let i = 0; i < 1024; i++) m.write8(SRC + i, (i * 7 + 3) & 255);
  const mv = (len, sh, so, dh, dof) => { const p = 0x8000; m.write32(p, len); m.write16(p + 4, sh); m.write32(p + 6, so); m.write16(p + 10, dh); m.write32(p + 12, dof); c.sregs[3] = 0; c.w16(6, p); return call(0x0B); };
  ok(mv(1024, 0, SRC, d.dx, 0).ax === 1, 'mover 1024 bytes convencional → EMB');
  ok(mv(512, d.dx, 0, d.dx, 256).ax === 1, 'mover dentro do mesmo EMB com sobreposição (memmove)');
  ok(mv(1024, d.dx, 0, 0, DST).ax === 1, 'mover EMB → convencional');
  let good = true; for (let i = 0; i < 256; i++) if (m.read8(DST + i) !== ((i * 7 + 3) & 255)) good = false; for (let i = 0; i < 512; i++) if (m.read8(DST + 256 + i) !== ((i * 7 + 3) & 255)) good = false;
  ok(good, 'conteúdo correto após as três cópias (inclusive a sobreposta)');
  ok(mv(1023, 0, SRC, d.dx, 0).bl === 0xA7, 'comprimento ímpar → A7h');
  ok(mv(2, 0x6666, 0, d.dx, 0).bl === 0xA3 && mv(2, 0, SRC, 0x6666, 0).bl === 0xA5, 'handles inválidos → A3h / A5h');
  ok(mv(2, d.dx, 600 << 10, 0, DST).bl === 0xA4 && mv(2, 0, SRC, d.dx, 600 << 10).bl === 0xA6, 'offsets fora do bloco → A4h / A6h');
  const r = call(0x0F, { dx: d.dx, bx: 100 }); ok(r.ax === 1 && call(0x0E, { dx: d.dx }).dx === 100, 'realocar para menor (100 KB)');
  ok(call(0x10, { dx: 16 }).bl === 0xB1, 'UMB indisponível → B1h');
  ok(call(0x77).bl === 0x80, 'função desconhecida → 80h');
  const a2 = call(0x89, { dx: 4 }); ok(a2.ax === 1, 'alocar (32 bits, função 89h)');
  c.w32(2, 0); call(0x88); ok(c.r32(0) > 0 && c.r32(1) === 0xFFFFFF, `88h: maior bloco ${c.r32(0)} KB, endereço mais alto ${c.r32(1).toString(16)}`);
}

console.log('\n[2] A20 e endereçamento da CPU');
{ const mb = mk(), c = mb.cpu, m = mb.mem; mb.xms.reset();
  c.sregs[3] = 0xFFFF; m.write8(0x100010, 0xAB); m.write8(0x10, 0xCD);          // FFFF:0020 = 1 MB + 16
  ok(c.rd8(3, 0x20) === 0xCD, 'A20 desligado: FFFF:0020 dá a volta e lê 0000:0010');
  c.w16(0, 0x0500); mb.xms.call(); ok(c.a20 === true && c.rd8(3, 0x20) === 0xAB, 'XMS 05h liga A20: FFFF:0020 lê o endereço 1 MB + 16');
  c.w16(0, 0x0600); mb.xms.call(); ok(c.a20 === false && c.rd8(3, 0x20) === 0xCD, 'XMS 06h desliga A20 de novo'); }

console.log('\n[3] INT 15h estendido e VDS (chamadas diretas)');
{ const mb = mk(), c = mb.cpu, x = mb.xms, m = mb.mem; x.reset();
  c.w16(0, 0x8800); ok(x.int15() && c.r16(0) === 15360 && !c.getF(1), 'INT 15h AH=88h → 15360 KB');
  c.w16(0, 0xE801); ok(x.int15() && c.r16(0) === 0x3C00 && c.r16(3) === 0, 'INT 15h AX=E801h → 3C00h KB, 0 acima de 16 MB');
  c.w16(0, 0x2401); ok(x.int15() === false, 'INT 15h AH=24h (A20) NÃO tratado: o HimemX real continua sem método de A20 (de propósito)');
  const gdt = 0x7000; m.data.fill(0, gdt, gdt + 0x30); const base = (d, v) => { m.write8(gdt + d + 2, v & 255); m.write8(gdt + d + 3, (v >> 8) & 255); m.write8(gdt + d + 4, (v >> 16) & 255); m.write8(gdt + d + 7, (v >>> 24)); };   // d = início do descritor
  for (let i = 0; i < 64; i++) m.write8(0x110000 + i, 0xA0 + (i & 15)); base(0x10, 0x110000); base(0x18, 0x9000);
  c.sregs[0] = 0; c.w16(6, gdt); c.w16(1, 32); c.w16(0, 0x8700); ok(x.int15() && c.r16(0) >> 8 === 0 && !c.getF(1), 'INT 15h AH=87h copiou 64 bytes de 1 MB+ para 0000:9000');
  ok(m.read8(0x9000) === 0xA0 && m.read8(0x903F) === 0xAF, 'conteúdo copiado correto');
  const dds = 0x8100; c.sregs[0] = 0; c.w16(7, dds); m.write32(dds, 0x100); m.write32(dds + 4, 0x0010); m.write16(dds + 8, 0x1234); c.w16(0, 0x8103); x.int4b();
  ok(!c.getF(1) && m.read32(dds + 0xC) === 0x12350, `VDS 8103h: endereço físico ${m.read32(dds + 0xC).toString(16)} (=1234h*16+10h)`);
  c.w16(0, 0x8199); ok(x.int4b() && c.getF(1) && (c.r16(0) & 255) === 0x0F, 'VDS: função desconhecida → CF=1, AL=0Fh');
  c.w16(0, 0x4300); ok(x.int4b() === false, 'INT 4Bh fora da família VDS (AH≠81h) não é tratado'); }

console.log('\n[4] GLaBIOS real: programa usa o XMS pela CPU emulada');
{
  const BOOT = Buffer.from('fa31c08ed88ec08ed0bc007cfbfcb80043cd2f30e4a30006b81043cd2f891e747d8c06767d31c08ec0b400ff1e747da30206b408ff1e747da30406b409ba4000ff1e747da30606891608068916787dbf0090b90001b83412ab050101e2fac70600800002c70602800000c70604800000c70606800090c70608800000a1787da30a80c7060c800001c7060e800000b40bbe0080ff1e747da30a06c70600800002a1787da30480c70606800001c70608800000c7060a800000c7060c8000a0c7060e800000b40bbe0080ff1e747da30c06be0090bf00a0b90001f3a7c7060e0601007406c7060e060000b40a8b16787dff1e747da31006b40a8b16787dff1e747da31206891e1406b405ff1e747da31606b407ff1e747da31806b406ff1e747db407ff1e747da31a06b488cd15a31c06c70600810001c70602810000c70604810090c70606810000c70608810000b8038131d2bf0081cd4b9c5883e001a31e06a10c81a32006a10e81a32206c70624060d60f4ebfe00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000055aa', 'hex'); const img = new Uint8Array(1474560); img.set(BOOT, 0);
  const mb = mk(); mb.setBIOSBinary(new Uint8Array(fs.readFileSync(romPath))); mb.loadDiskImage(0, img);
  const lg = console.log; console.log = () => {}; console.warn = () => {};
  mb.powerOn(); await new Promise((r) => setTimeout(r, 3500)); mb.powerOff(); console.log = lg;
  const w = (o) => mb.mem.read16(0x600 + o);
  ok(w(0x24) === 0x600D, 'programa de teste terminou (marcador 600D)');
  ok(w(0) === 0x80, `INT 2Fh AX=4300h → AL=${w(0).toString(16)}h (driver instalado)`);
  ok(w(2) === 0x0300, `XMS 00h: versão ${w(2).toString(16)}`);
  ok(w(4) === 15360, `XMS 08h: ${w(4)} KB livres`);
  ok(w(6) === 1 && w(8) !== 0, `XMS 09h: alocou 64 KB, handle ${w(8)}`);
  ok(w(0xA) === 1 && w(0xC) === 1, 'XMS 0Bh: moveu 512 bytes para o EMB e de volta (duas chamadas)');
  ok(w(0xE) === 1, 'conteúdo idêntico após ida e volta (REPE CMPSW)');
  ok(w(0x10) === 1 && w(0x12) === 0 && (w(0x14) & 255) === 0xA2, 'XMS 0Ah: liberou; liberar de novo → AX=0, BL=A2h');
  ok(w(0x16) === 1 && w(0x18) === 1 && w(0x1A) === 0, 'A20: ligar → consulta 1; desligar → consulta 0');
  ok(w(0x1C) === 15360, `INT 15h AH=88h pela ROM → ${w(0x1C)} KB`);
  ok(w(0x1E) === 0 && w(0x20) === 0x9000 && w(0x22) === 0, `VDS 8103h: CF=${w(0x1E)}, físico ${w(0x22).toString(16)}:${w(0x20).toString(16)}`);
  ok(mb._loopErrors === 0, `erros da CPU: ${mb._loopErrors}`);
}
console.log(fails ? `\n✘ ${fails} falha(s)` : '\n✔ XMS/VDS/INT 15h: todos os testes passaram'); process.exit(fails ? 1 : 0);
