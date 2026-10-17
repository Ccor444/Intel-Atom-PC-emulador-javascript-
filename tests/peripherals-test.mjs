// node peripherals-test.mjs [roms/GLABIOS_0.4.2_8P.ROM]
// COM1 (UART 16550A) e LPT1 (porta paralela): registradores, detecção no POST da GLaBIOS e uso real pelos
// INT 14h / INT 17h DA ROM (boot sector que envia "Hello COM+LPT!" pelas duas portas).
import fs from 'node:fs';
import { Motherboard } from '../src/motherboard.js';
import { UART16550, ParallelPort } from '../src/devices.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
let fails = 0; const ok = (c, m) => { console.log(`${c ? '  ✔' : '  ✘'} ${m}`); if (!c) fails++; };
const romPath = process.argv[2] || 'roms/GLABIOS_0.4.2_8P.ROM';

console.log('[1] UART 16550A');
{ const u = new UART16550(); const tx = []; u.onTx = (b) => tx.push(b);
  ok(u.read(0x3FA) === 0x01, 'IIR = 0x01 (nibble alto zero: é o que a GLaBIOS exige para detectar)');
  u.write(0x3FA, 0); ok(u.read(0x3FA) === 0x01, 'após escrever 0 em FCR, IIR continua 0x01');
  ok(u.read(0x3FD) === 0x60, 'LSR = 0x60 (THR e TEMT vazios)');
  u.write(0x3FF, 0xA5); ok(u.read(0x3FF) === 0xA5, 'registrador scratch guarda 0xA5');
  u.write(0x3FB, 0x80); u.write(0x3F8, 12); u.write(0x3F9, 0); ok(u.read(0x3F8) === 12 && u.read(0x3F9) === 0, 'DLAB: divisor 12 (9600 bps)'); u.write(0x3FB, 0x03);
  u.write(0x3F8, 0x41); ok(tx.join() === '65', 'THR → onTx recebeu 0x41');
  u.write(0x3FC, 0x10); u.write(0x3F8, 0x5A); ok(u.read(0x3FD) & 1, 'loopback: dado pronto no LSR'); ok(u.read(0x3F8) === 0x5A && !(u.read(0x3FD) & 1) && tx.length === 1, 'loopback devolve 0x5A e não sai pela linha');
  u.write(0x3FC, 0x10 | 3); ok((u.read(0x3FE) & 0x30) === 0x30, 'loopback: RTS→CTS, DTR→DSR no MSR');
  u.receive(0x31); u.write(0x3FC, 0); ok(u.read(0x3FD) === 0x61 && u.read(0x3F8) === 0x31, 'receive(): byte chega pelo RBR'); }

console.log('\n[2] Porta paralela');
{ const p = new ParallelPort(); const pr = []; p.onPrint = (b) => pr.push(b);
  p.write(0x378, 0x0B); ok(p.read(0x378) === 0x0B, 'dados: escreve 0x0B e relê 0x0B (teste da GLaBIOS)');
  ok(p.read(0x379) === 0xDF, 'status 0xDF (não ocupada, sem erro)');
  p.write(0x37A, 0x0C); p.write(0x378, 0x48); p.write(0x37A, 0x0D); ok(pr.length === 0, 'STROBE subindo ainda não imprime'); p.write(0x37A, 0x0C);
  ok(pr.join() === '72', 'borda de descida do STROBE imprime 0x48 ("H")'); }

console.log('\n[3] GLaBIOS real: detecção no POST + INT 14h/17h da ROM');
const BOOT = Buffer.from('fa31c08ed88ec08ed0bc007cfbfc31d2b400b0e3cd14a30006be507cac84c0741488c3b40188d831d2cd14b40088d831d2cd17ebe7b40331d2cd14a30206b40231d2cd17a30406c70606060d60f4ebe548656c6c6f20434f4d2b4c5054210d0a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000055aa', 'hex');
const img = new Uint8Array(1474560); img.set(BOOT, 0);
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16 });
mb.setBIOSBinary(new Uint8Array(fs.readFileSync(romPath))); mb.loadDiskImage(0, img);
const lg = console.log; console.log = () => {}; console.warn = () => {};
mb.powerOn(); await new Promise((r) => setTimeout(r, 4000)); mb.powerOff(); console.log = lg;
const rows = []; for (let y = 0; y < 25; y++) { let l = ''; for (let x = 0; x < 80; x++) { const c = mb.mem.read8(0xB8000 + (y * 80 + x) * 2); l += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; } rows.push(l.trimEnd()); }
const txt = rows.join('\n');
ok(/LPT\s+\[ 0378 \]/.test(txt) && /COM\s+\[ 03F8 \]/.test(txt), 'POST mostra "LPT [ 0378 ]" e "COM [ 03F8 ]"');
ok(mb.mem.read16(0x400) === 0x3F8 && mb.mem.read16(0x408) === 0x378, `BDA: COM1=${mb.mem.read16(0x400).toString(16)} LPT1=${mb.mem.read16(0x408).toString(16)}`);
ok(mb.mem.read16(0x606) === 0x600D, 'programa de teste chegou ao fim (marcador 600D)');
ok(mb.uart.txLog === 'Hello COM+LPT!\r\n', `UART recebeu ${JSON.stringify(mb.uart.txLog)} pelo INT 14h da ROM`);
ok(mb.lpt.printed === 'Hello COM+LPT!\r\n', `impressora recebeu ${JSON.stringify(mb.lpt.printed)} pelo INT 17h da ROM`);
const st14 = mb.mem.read16(0x602), st17 = mb.mem.read16(0x604);
console.log(`     INT 14h AH=3 → AX=${st14.toString(16)} (AH=LSR, AL=MSR) · INT 17h AH=2 → AX=${st17.toString(16)}`);
ok(mb._loopErrors === 0, `erros da CPU: ${mb._loopErrors}`);
console.log(fails ? `\n✘ ${fails} falha(s)` : '\n✔ periféricos: todos os testes passaram'); process.exit(fails ? 1 : 0);
