// Verifica o INT 13h (HLE) contra uma imagem de 1,44 MB: TODOS os 2880 setores por CHS, leituras
// multi-setor, limites, AH=08 e registradores preservados — o que o setor de boot do FreeDOS usa.
import { Motherboard } from '../src/motherboard.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });
const IMG = new Uint8Array(1474560);
for (let lba = 0; lba < 2880; lba++) for (let i = 0; i < 512; i++) IMG[lba * 512 + i] = (lba * 7 + i * 3 + (lba >> 8)) & 255;
mb.loadDiskImage(0, IMG);
const c = mb.cpu; let fails = 0;
const ok = (cond, m) => { if (!cond) { fails++; if (fails <= 15) console.log('  ✘', m); } };
const call = (ah, al, cyl, head, sec, es = 0x1000, bx = 0x0200, dl = 0) => {
  c.w16(0, (ah << 8) | al); c.w16(1, ((cyl & 255) << 8) | ((cyl >> 8) << 6) | sec); c.w16(2, (head << 8) | dl);
  c.w16(3, bx); c.sregs[0] = es; c.setF(1, 0); mb._int13();
  return { ah: c.r16(0) >> 8, al: c.r16(0) & 255, cf: c.getF(1) };
};
const same = (lba, n, es = 0x1000, bx = 0x0200) => { const d = (es << 4) + bx; for (let i = 0; i < n * 512; i++) if (mb.mem.read8(d + i) !== IMG[lba * 512 + i]) return false; return true; };

let reads = 0;
for (let cyl = 0; cyl < 80; cyl++) for (let head = 0; head < 2; head++) for (let sec = 1; sec <= 18; sec++) {
  const lba = (cyl * 2 + head) * 18 + sec - 1;
  const r = call(2, 1, cyl, head, sec);
  ok(!r.cf && r.ah === 0 && r.al === 1 && same(lba, 1), `CHS ${cyl}/${head}/${sec} (LBA ${lba}): cf=${r.cf} ah=${r.ah}`); reads++;
}
console.log(`✔ ${reads} leituras de 1 setor por CHS`);
for (const [cyl, head, sec, n] of [[0, 0, 1, 18], [0, 0, 10, 18], [1, 1, 5, 9], [79, 1, 1, 18], [79, 0, 1, 36], [20, 0, 1, 1]]) {
  const lba = (cyl * 2 + head) * 18 + sec - 1, r = call(2, n, cyl, head, sec, 0x2000, 0x0000);
  ok(!r.cf && r.al === n && same(lba, n, 0x2000, 0), `multi ${cyl}/${head}/${sec} ×${n}: cf=${r.cf} ah=${r.ah} al=${r.al}`);
}
console.log('✔ leituras multi-setor (inclui cruzar trilha e o último cilindro)');
let r = call(2, 1, 80, 0, 1); ok(r.cf && r.ah === 4, 'cilindro 80 → erro 04'); r = call(2, 1, 0, 2, 1); ok(r.cf && r.ah === 4, 'cabeça 2 → erro 04');
r = call(2, 1, 0, 0, 19); ok(r.cf && r.ah === 4, 'setor 19 → erro 04'); r = call(2, 1, 0, 0, 1, 0x1000, 0x200, 1); ok(r.cf && r.ah === 0x80, 'drive 1 → 0x80');
r = call(8, 0, 0, 0, 0); ok(!r.cf && (c.r16(1) >> 8) === 79 && (c.r16(1) & 63) === 18 && (c.r16(2) >> 8) === 1, `AH=08: CH=${c.r16(1) >> 8} CL=${c.r16(1) & 255} DH=${c.r16(2) >> 8} DL=${c.r16(2) & 255}`);
// FreeDOS lê com ES:BX perto do fim do segmento (BX = 0xFE00) e depois avança ES
r = call(2, 1, 3, 1, 7, 0x0060, 0xFE00); ok(!r.cf && same((3 * 2 + 1) * 18 + 6, 1, 0x0060, 0xFE00), 'leitura em ES:BX=0060:FE00');
// registradores preservados (CX/DX/BX/ES) após AH=02
c.w16(1, 0x0507); c.w16(2, 0x0100); c.w16(3, 0x0200); c.sregs[0] = 0x1000; c.w16(0, 0x0201); mb._int13();
ok(c.r16(1) === 0x0507 && c.r16(2) === 0x0100 && c.r16(3) === 0x0200 && c.sregs[0] === 0x1000, 'CX, DX, BX, ES preservados');
console.log(fails ? `✘ ${fails} falha(s)` : '✔ INT 13h HLE: todos os testes passaram'); process.exit(fails ? 1 : 0);
