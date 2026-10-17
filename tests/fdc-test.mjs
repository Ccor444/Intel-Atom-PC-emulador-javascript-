// node tests/fdc-test.mjs — controlador de disquete µPD765 (src/fdc.js) contra o DMA 8237 real (src/devices.js)
// e um disco de 1,44 MB. Cada comando é enviado pelas portas 0x3F4/0x3F5 e o resultado é lido de volta.
import { FDC765 } from '../src/fdc.js';
import { DMA8237, PIC8259 } from '../src/devices.js';
let fails = 0; const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) fails++; };

const DISK = new Uint8Array(1474560);
for (let i = 0; i < DISK.length; i++) DISK[i] = (i * 31 + (i >> 9) * 7 + 3) & 0xFF;     // conteúdo único por setor
const writes = [];
const media = () => ({
  read(lba, n) { return DISK.slice(lba * 512, (lba + n) * 512); },
  write(lba, buf) { writes.push(lba); DISK.set(buf.subarray(0, 512), lba * 512); },
});
const RAM = new Uint8Array(0x100000);
const mem = { write8: (a, v) => { RAM[a] = v; }, read8: (a) => RAM[a] };
const pic = { irq: new Set(), raiseIRQ(n) { this.irq.add(n); }, lowerIRQ(n) { this.irq.delete(n); } };
const dma = new DMA8237();
const fdc = new FDC765({ dma, pic, mem, media });

const put = (b) => { for (const x of b) fdc.write(0x3F5, x); };
const get = (n) => { const r = []; for (let i = 0; i < n; i++) r.push(fdc.read(0x3F5)); return r; };
const msr = () => fdc.read(0x3F4);
const hex = (a) => a.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const progDma = (linear, bytes) => {                  // canal 2: endereço (página+16 bits), contagem = bytes-1, modo, desmascara
  dma.write(0x0C, 0);                                  // limpa flip-flop
  dma.write(0x04, linear & 0xFF); dma.write(0x04, (linear >> 8) & 0xFF);
  dma.write(0x81, (linear >> 16) & 0xFF);
  dma.write(0x0C, 0);
  dma.write(0x05, (bytes - 1) & 0xFF); dma.write(0x05, ((bytes - 1) >> 8) & 0xFF);
  dma.write(0x0B, 0x46);                               // canal 2, leitura de disco → memória (escrita na RAM)
  dma.write(0x0A, 0x02);                               // desmascara canal 2
};
const progDmaWrite = (linear, bytes) => { progDma(linear, bytes); dma.write(0x0B, 0x4A); };
const ramSector = (a, n) => Array.from(RAM.subarray(a, a + n));
const diskSector = (lba) => Array.from(DISK.subarray(lba * 512, lba * 512 + 512));

// ---- comandos de controle --------------------------------------------------------------------
ok(msr() === 0x80, `MSR ocioso = 80h (${msr().toString(16)})`);
put([0x03, 0xAF, 0x02]);                                      // SPECIFY
ok(msr() === 0x80, 'SPECIFY não tem fase de resultado');
put([0x10]); ok(msr() === 0xD0, 'MSR = D0h com resultado pendente'); ok(get(1)[0] === 0x90, 'VERSION → 90h (765A)');
put([0x1F]); ok(get(1)[0] === 0x80, 'comando inválido → ST0 = 80h');
put([0x07, 0x00]);                                            // RECALIBRATE drive 0
ok(pic.irq.has(6), 'RECALIBRATE levanta IRQ6');
put([0x08]); const si = get(2);
ok(si[0] === 0x20 && si[1] === 0x00, `SENSE INTERRUPT após recalibrar: ${hex(si)} (20h, PCN 0)`);
ok(!pic.irq.has(6), 'SENSE INTERRUPT abaixa IRQ6');
put([0x08]); ok(get(1)[0] === 0x80, 'segundo SENSE INTERRUPT sem interrupção → 80h');

put([0x0F, 0x00, 0x05]);                                      // SEEK drive 0 → cilindro 5
ok(pic.irq.has(6), 'SEEK levanta IRQ6');
put([0x08]); const sk = get(2); ok(sk[0] === 0x20 && sk[1] === 5, `SENSE após SEEK(5): ${hex(sk)} (PCN 5)`);
put([0x0F, 0x00, 0x00]); put([0x08]); get(2);                  // volta ao cilindro 0

// ---- leitura de dados ---------------------------------------------------------------------------
const BUF = 0x20000;
progDma(BUF, 512);
put([0x46, 0x00, 0x00, 0x00, 0x01, 0x02, 0x01, 0x1B, 0xFF]);   // READ DATA (MFM) drive0 C0 H0 R1 N2 EOT1
ok(msr() === 0xD0, 'após READ DATA há 7 bytes de resultado');
const rd = get(7);
ok(rd[0] === 0x00 && rd[1] === 0 && rd[2] === 0 && rd[3] === 0 && rd[4] === 0 && rd[5] === 1 && rd[6] === 2,
   `READ 1 setor: resultado ${hex(rd)} (ST0 00, ST1/2 00, C0 H0 R1 N2)`);
ok(ramSector(BUF, 512).join() === diskSector(0).join(), 'setor 0 copiado para a RAM via DMA, byte a byte');
ok(pic.irq.has(6), 'READ DATA levanta IRQ6');
put([0x08]); get(2);
ok((dma.status & 0x04) !== 0, 'DMA sinalizou terminal count no canal 2');

progDma(BUF, 3 * 512);
put([0x46, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x1B, 0xFF]);  // 3 setores (EOT 18)
const rd3 = get(7);
ok(rd3[5] === 3, `3 setores: último R = ${rd3[5]} (esperado 3)`);
ok([0, 1, 2].every((i) => ramSector(BUF + i * 512, 512).join() === diskSector(i).join()), '3 setores consecutivos na RAM (LBA 0..2)');

// cruzamento de trilha: C0 H0 R17, 3 setores com EOT 18 → (0,0,17), (0,0,18), (0,1,1)
progDma(BUF, 3 * 512);
put([0x46, 0x00, 0x00, 0x00, 0x11, 0x02, 0x12, 0x1B, 0xFF]);
const rdx = get(7);
ok(rdx[4] === 1 && rdx[5] === 1, `cabeça 0→1 ao passar do setor 18: resultado H=${rdx[4]} R=${rdx[5]}`);
ok(ramSector(BUF + 1024, 512).join() === diskSector(18).join(), 'o 3º setor é (C0,H1,R1) = LBA 18');

// leitura fora do disco
progDma(BUF, 512);
put([0x46, 0x00, 0x50, 0x00, 0x01, 0x02, 0x01, 0x1B, 0xFF]);  // C=80 (não existe)
const bad = get(7);
ok((bad[0] & 0xC0) === 0x40 && bad[1] === 0x04, `setor inexistente: ST0=${bad[0].toString(16)} ST1=${bad[1].toString(16)} (IC=01, ND)`);

// ---- escrita ------------------------------------------------------------------------------------
for (let i = 0; i < 512; i++) RAM[BUF + i] = (i ^ 0x5A) & 0xFF;
progDmaWrite(BUF, 512);
put([0xC5, 0x00, 0x00, 0x00, 0x05, 0x02, 0x05, 0x1B, 0xFF]);  // WRITE DATA C0 H0 R5
const wr = get(7);
ok(wr[0] === 0x00 && wr[5] === 5, `WRITE 1 setor: ${hex(wr)}`);
ok(writes.includes(4) && diskSector(4).every((v, i) => v === ((i ^ 0x5A) & 0xFF)), 'setor 5 (LBA 4) gravado no disco com os bytes do DMA');

// ---- DOR: reset do controlador ----------------------------------------------------------------------
fdc.write(0x3F2, 0x00);                                        // /RESET = 0
fdc.write(0x3F2, 0x0C);                                        // /RESET = 1 (libera)
ok(pic.irq.has(6) || fdc.pendingInt, 'reset do controlador deixa interrupção pendente');
console.log(fails ? `\n✘ ${fails} falha(s)` : '\n✔ µPD765: todos os testes passaram'); process.exit(fails ? 1 : 0);
