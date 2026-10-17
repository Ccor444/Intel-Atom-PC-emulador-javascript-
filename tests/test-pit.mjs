// Uso:  node test-pit.mjs [caminho/GLABIOS_0.4.2_8P.ROM]
// (coloque este arquivo na raiz do projeto, ao lado de src/; package.json com "type":"module")
import { PIT8254, PIC8259, MonotonicClock, PIT_TICKS_PER_MS } from '../src/devices.js';
import { Motherboard } from '../src/motherboard.js';
import fs from 'node:fs';

let fails = 0;
const ok = (c, msg) => { console.log(`${c ? '  ✔' : '  ✘'} ${msg}`); if (!c) fails++; };

// relógio falso: controle direto em ticks do PIT
const fake = () => {
  const c = { t: 0, now() { return this.t; }, setTicks(n) { this.t = (n + 0.5) / PIT_TICKS_PER_MS; } };
  return c;
};
const mkPit = () => { const clk = fake(), irqs = [], pic = { raiseIRQ: (n) => irqs.push(n) };
  const pit = new PIT8254(pic, clk); return { clk, irqs, pit }; };
const wr = (pit, p, v) => pit.write(p, v);

console.log('\n[1] Latch + leitura de 2 bytes');
{
  const { clk, pit } = mkPit();
  clk.setTicks(0);
  wr(pit, 0x43, 0x34); wr(pit, 0x40, 0x00); wr(pit, 0x40, 0x00);      // ch0, lo/hi, modo 2, count 65536
  clk.setTicks(1000);                                                  // 999 ticks após a carga (start = 1)
  wr(pit, 0x43, 0x00);                                                 // latch ch0
  clk.setTicks(5000);                                                  // tempo passa ANTES da leitura
  const lo = pit.read(0x40), hi = pit.read(0x40), v = lo | hi << 8;
  ok(v === 65536 - 999, `valor latched = ${v} (esperado ${65536 - 999}) mesmo lido 4000 ticks depois`);
  wr(pit, 0x43, 0x00); wr(pit, 0x43, 0x00);                            // 2º latch é ignorado até ler
  const l2 = pit.read(0x40), h2 = pit.read(0x40);
  ok((l2 | h2 << 8) === 65536 - 4999, `novo latch após leitura = ${l2 | h2 << 8}`);
  // read-back status: modo 2, lo/hi, binário => 0b?0110100 (OUT=1, null=0)
  wr(pit, 0x43, 0xE2);                                                 // read-back: /COUNT=1, /STATUS=0, ch0
  const st = pit.read(0x40);
  ok(st === 0x80 + 0x30 + 0x04, `read-back status = 0x${st.toString(16)} (esperado 0xb4)`);
  // modos de acesso low-only / high-only / BCD
  wr(pit, 0x43, 0x50); wr(pit, 0x41, 200);                             // ch1 low-only modo 0, count 200
  clk.setTicks(5100);
  wr(pit, 0x43, 0x40); ok(pit.read(0x41) === 200 - 99, `low-only count = ${200 - 99}`);
  wr(pit, 0x43, 0x65); wr(pit, 0x41, 0x10);                           // ch1 high-only, modo 2, BCD, count 0x1000 (=1000)
  clk.setTicks(5100 + 101);                                            // 100 ticks contados
  wr(pit, 0x43, 0x40); ok(pit.read(0x41) === 0x09, 'high-only BCD: 1000-100 = 900 → byte alto 0x09');
}

console.log('\n[2] Modo 2, canal 0, count 1000: IRQ0 dispara');
{
  const { clk, irqs, pit } = mkPit();
  clk.setTicks(0);
  wr(pit, 0x43, 0x34); wr(pit, 0x40, 1000 & 255); wr(pit, 0x40, 1000 >> 8);
  clk.setTicks(1000); pit.sync();
  ok(irqs.length === 0, 'sem IRQ com 1000 ticks (1 CLK de carga + 999 de contagem)');
  clk.setTicks(1001); pit.sync();
  ok(irqs.length === 1, 'IRQ0 em 1001 ticks (1 CLK de carga + 1000 contados, ~0.84 ms)');
  clk.setTicks(3500); pit.sync();
  ok(irqs.length === 2, 'mais 1 notificação (coalescida) depois de 2 períodos; ' + `total=${irqs.length}`);
  ok(pit.getOut(0) === 1, 'OUT0 alto fora do pulso de 1 CLK');
  clk.setTicks(1 + 4 * 1000 - 1); ok(pit.getOut(0) === 0, 'OUT0 baixo por 1 CLK quando count=1');
}

console.log('\n[3] Tempo real: 10 ms ≈ 11931 ticks');
{
  const pit = new PIT8254(new PIC8259());
  pit.write(0x43, 0x34); pit.write(0x40, 0); pit.write(0x40, 0);
  const rd = () => { pit.write(0x43, 0); return pit.read(0x40) | pit.read(0x40) << 8; };
  const t0 = performance.now(), a = rd();
  while (performance.now() - t0 < 10) { /* espera 10 ms */ }
  const b = rd(), dt = performance.now() - t0, d = ((a - b) + 65536) % 65536;
  const exp = dt * PIT_TICKS_PER_MS;
  ok(Math.abs(d - exp) < exp * 0.03 + 20, `delta=${d} ticks em ${dt.toFixed(3)} ms (esperado ≈ ${exp.toFixed(0)})`);
}

console.log('\n[4] Rajada: 100 leituras em < 1 ms');
{
  // (a) relógio real do Node
  const pit = new PIT8254(new PIC8259());
  pit.write(0x43, 0x34); pit.write(0x40, 0); pit.write(0x40, 0);
  const vals = [], t0 = performance.now();
  for (let i = 0; i < 100; i++) { pit.write(0x43, 0); vals.push(pit.read(0x40) | pit.read(0x40) << 8); }
  const dt = performance.now() - t0;
  ok(new Set(vals).size > 1 && vals[99] < vals[0], `real: ${new Set(vals).size} valores distintos em ${dt.toFixed(3)} ms`);

  // (b) relógio arredondado a 100 µs (Chrome) + interpolação por instruções
  let steps = 0;
  const quant = () => Math.floor(steps / 20000 / 0.1) * 0.1;           // 20 000 passos/ms, degrau 0.1 ms
  const clk = new MonotonicClock({ real: quant, steps: () => steps });
  const p2 = new PIT8254(new PIC8259(), clk);
  p2.write(0x43, 0x34); p2.write(0x40, 0); p2.write(0x40, 0);
  for (let i = 0; i < 2000; i++) { steps += 10; clk.now(); }          // aquecimento: aprende degrau e taxa
  const out = [], tr = [];
  for (let i = 0; i < 100; i++) {
    steps += 50;                                                       // 100 leituras ≈ 0.25 ms emulados
    p2.write(0x43, 0); out.push(p2.read(0x40) | p2.read(0x40) << 8);
    tr.push(steps / 20000);
  }
  const distinct = new Set(out).size;
  ok(distinct >= 20, `relógio 100 µs: ${distinct} valores distintos em 100 leituras (sem interpolação seriam ~3)`);
  let mono = true; for (let i = 1; i < out.length; i++) if (out[i] > out[i - 1] && out[i - 1] - out[i] > -100) mono = false;
  ok(mono, 'sequência monotônica decrescente');
  const tNow = clk.now(), trueT = steps / 20000;
  ok(tNow <= trueT + 0.1 && tNow >= trueT - 0.11, `sem deriva: relógio virtual ${tNow.toFixed(4)} ms vs real ${trueT.toFixed(4)} ms`);
}

console.log('\n[extra] Modos 0-5, GATE, BCD');
{
  const { clk, irqs, pit } = mkPit();
  // Modo 0: OUT baixo até TC, depois alto; continua contando (FFFF…)
  clk.setTicks(0); wr(pit, 0x43, 0x30); wr(pit, 0x40, 10); wr(pit, 0x40, 0);
  clk.setTicks(10); ok(pit.getOut(0) === 0, 'modo 0: OUT baixo antes do TC');
  clk.setTicks(11); pit.sync(); ok(pit.getOut(0) === 1 && irqs.length === 1, 'modo 0: OUT sobe 11 CLK após escrita → IRQ0');
  clk.setTicks(13); wr(pit, 0x43, 0); const lo = pit.read(0x40), hi = pit.read(0x40);
  ok((lo | hi << 8) === 0xFFFE, `modo 0: segue contando após TC (0x${(lo | hi << 8).toString(16)})`);
  // Modo 3: onda quadrada, contagem de 2 em 2
  clk.setTicks(500); wr(pit, 0x43, 0x36); wr(pit, 0x40, 100); wr(pit, 0x40, 0); const S = 501;   // count 100; origem = tick 501
  clk.setTicks(S + 49); ok(pit.getOut(0) === 1, 'modo 3: alto na 1ª metade');
  clk.setTicks(S + 50); ok(pit.getOut(0) === 0, 'modo 3: baixo na 2ª metade');
  wr(pit, 0x43, 0); const m3 = pit.read(0x40) | pit.read(0x40) << 8;
  ok(m3 === 100, `modo 3: contador recarrega N na metade (=${m3})`);
  clk.setTicks(S + 60); wr(pit, 0x43, 0); const m3b = pit.read(0x40) | pit.read(0x40) << 8;
  ok(m3b === 80, `modo 3: decrementa de 2 em 2 (=${m3b})`);
  // Modo 4: pulso de 1 CLK em TC, sem repetir
  clk.setTicks(1000); wr(pit, 0x43, 0x38); wr(pit, 0x40, 5); wr(pit, 0x40, 0); const S4 = 1001;
  clk.setTicks(S4 + 4); ok(pit.getOut(0) === 1, 'modo 4: alto antes do TC');
  clk.setTicks(S4 + 5); ok(pit.getOut(0) === 0, 'modo 4: baixo 1 CLK em TC');
  clk.setTicks(S4 + 6); ok(pit.getOut(0) === 1, 'modo 4: volta a alto');
  // Modo 1 e 5: dependem de GATE
  wr(pit, 0x43, 0x72); wr(pit, 0x41, 4); wr(pit, 0x41, 0);             // ch1 modo 1 (gate já em 1, sem borda)
  clk.setTicks(1100); ok(pit.getOut(1) === 1, 'modo 1: OUT alto sem trigger');
  pit.setGate(1, 0); clk.setTicks(1101); pit.setGate(1, 1);            // borda de subida
  clk.setTicks(1102); ok(pit.getOut(1) === 0, 'modo 1: OUT baixo após trigger');
  clk.setTicks(1101 + 1 + 4 + 1); ok(pit.getOut(1) === 1, 'modo 1: OUT sobe após N CLKs');
  // Modo 2 + GATE do canal 2: pausa e recarrega
  clk.setTicks(2000); wr(pit, 0x43, 0xB4); wr(pit, 0x42, 50); wr(pit, 0x42, 0);   // ch2 modo 2, gate baixo no reset
  clk.setTicks(2100); wr(pit, 0x43, 0x80); const g0 = pit.read(0x42) | pit.read(0x42) << 8;
  ok(g0 === 50, `canal 2 com GATE=0 não conta (=${g0})`);
  pit.setGate(2, 1); clk.setTicks(2110); wr(pit, 0x43, 0x80);
  const g1 = pit.read(0x42) | pit.read(0x42) << 8; ok(g1 === 50 - 9, `GATE sobe: carrega e conta (=${g1})`);
  // BCD
  clk.setTicks(3000); wr(pit, 0x43, 0x35); wr(pit, 0x40, 0x00); wr(pit, 0x40, 0x10); // ch0 modo 2 BCD count 1000
  clk.setTicks(3000 + 1 + 5); wr(pit, 0x43, 0); const b = pit.read(0x40) | pit.read(0x40) << 8;
  ok(b === 0x0995, `BCD: 1000-5 = 995 → 0x${b.toString(16)}`);
}

// ------------------------------------------------------------------
// Boot headless (Node): ROM sintética que reproduz o loop de espera do PIT da GLaBIOS
// ------------------------------------------------------------------
const stubCanvas = { getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

function makeRom(code, entry = 0x0000) {
  const rom = new Uint8Array(0x10000); rom.set(code, entry);
  rom.set([0xEA, entry & 255, entry >> 8, 0x00, 0xF0], 0xFFF0);
  return rom;
}
const screenText = (mb) => { let o = ''; for (let y = 0; y < 25; y++) { let l = ''; for (let x = 0; x < 80; x++) { const c = mb.mem.read8(0xB8000 + (y * 80 + x) * 2); l += c >= 32 ? String.fromCharCode(c) : ' '; } o += l.trimEnd() + '\n'; } return o; };
const run = (mb, ms) => new Promise((res) => { mb.powerOn(); setTimeout(() => { mb.powerOff(); res(); }, ms); });

console.log('\n[5a] ROM sintética: espera o contador do PIT mudar (padrão da rotina em 0xFE6AA)');
{
  const c = [
    0xFA, 0xFC, 0x31, 0xC0, 0x8E, 0xD0, 0xBC, 0x00, 0x70,           // cli; cld; xor ax,ax; mov ss,ax; mov sp,7000
    0xB0, 0x34, 0xE6, 0x43, 0xB0, 0x00, 0xE6, 0x40, 0xE6, 0x40,     // ch0, lo/hi, modo 2, count 0
    0xE8, 0x1E, 0x00, 0x89, 0xC3,                                    // call rd ; mov bx,ax
    /*loop:*/ 0xE8, 0x17, 0x00, 0x39, 0xD8, 0x74, 0xF9,             // call rd ; cmp ax,bx ; je loop
    0xB8, 0x00, 0xB8, 0x8E, 0xD8, 0xC7, 0x06, 0x00, 0x00, 0x4F, 0x07, // mov ax,B800; mov ds,ax; mov [0],074F ('O')
    0xC7, 0x06, 0x02, 0x00, 0x4B, 0x07, 0xF4,                        // mov [2],074B ('K'); hlt
    0xEB, 0xFD,
  ];
  // rotina rd (mesma da GLaBIOS): pushf; cli; out 43,al(0); in al,40; mov ah,al; in al,40; popf; xchg al,ah; ret
  while (c.length < 0x40) c.push(0x90);
  c.splice(0x40, 0, 0x9C, 0xFA, 0xB0, 0x00, 0xE6, 0x43, 0xE4, 0x40, 0x88, 0xC4, 0xE4, 0x40, 0x9D, 0x86, 0xC4, 0xC3);
  // recalcula deslocamentos dos CALLs
  const rd = 0x40;
  const fix = (at) => { const rel = rd - (at + 3); c[at + 1] = rel & 255; c[at + 2] = (rel >> 8) & 255; };
  fix(19); fix(24);
  const mb = new Motherboard(stubCanvas, { ramMB: 1 });
  mb.setBIOSBinary(makeRom(new Uint8Array(c)));
  const t0 = performance.now(); await run(mb, 300);
  const txt = screenText(mb);
  ok(txt.startsWith('OK'), `CPU saiu do loop de espera e escreveu "${txt.slice(0, 2)}" (${(performance.now() - t0) | 0} ms)`);
}

console.log('\n[5b] ROM sintética: PIC + IRQ0 + ISR da ROM + acordar de HLT');
{
  const c = new Array(0x100).fill(0x90); let p = 0; const e = (...b) => { for (const x of b) c[p++] = x; };
  e(0xFA, 0x31, 0xC0, 0x8E, 0xD8, 0x8E, 0xD0, 0xBC, 0x00, 0x70);     // cli; xor ax,ax; mov ds,ax; mov ss,ax; mov sp,7000
  e(0xC7, 0x06, 0x20, 0x00, 0x80, 0x00, 0xC7, 0x06, 0x22, 0x00, 0x00, 0xF0); // IVT[8] = F000:0080
  e(0xB0, 0x11, 0xE6, 0x20, 0xB0, 0x08, 0xE6, 0x21, 0xB0, 0x00, 0xE6, 0x21, 0xB0, 0x01, 0xE6, 0x21, 0xB0, 0xFE, 0xE6, 0x21); // ICW1-4, IMR=FE
  e(0xB0, 0x34, 0xE6, 0x43, 0xB0, 0x9C, 0xE6, 0x40, 0xB0, 0x2E, 0xE6, 0x40); // ch0 modo 2, count 0x2E9C=11932 (~100 Hz)
  e(0xFB);                                                            // sti
  const loop = p;
  e(0xF4, 0x81, 0x3E, 0x00, 0x05, 0x05, 0x00, 0x72, loop - (p + 8));   // hlt; cmp word [0500],5 ; jb loop  (offset ajustado abaixo)
  c[p - 1] = (loop - p) & 0xFF;
  e(0xB8, 0x00, 0xB8, 0x8E, 0xD8, 0xC7, 0x06, 0x00, 0x00, 0x49, 0x07, 0xC7, 0x06, 0x02, 0x00, 0x52, 0x07, 0xF4); // 'I','R' ; hlt
  // ISR em F000:0080: inc word [0500]; mov al,20; out 20,al; iret   (DS=0 porque o main roda com DS=0 até 'mov ax,B800')
  const isr = [0x50, 0x1E, 0x31, 0xC0, 0x8E, 0xD8, 0xFF, 0x06, 0x00, 0x05, 0xB0, 0x20, 0xE6, 0x20, 0x1F, 0x58, 0xCF];
  c.splice(0x80, isr.length, ...isr);
  const mb = new Motherboard(stubCanvas, { ramMB: 1 });
  mb.setBIOSBinary(makeRom(new Uint8Array(c)));
  await run(mb, 600);
  const cnt = mb.mem.read16(0x500);
  ok(cnt >= 5, `ISR da ROM rodou ${cnt}× via IVT (IRQ0 do PIT → 8259 → CPU, acordando de HLT)`);
  ok(screenText(mb).startsWith('IR'), `texto na tela: "${screenText(mb).slice(0, 2)}"`);
}

const romPath = process.argv[2];
if (romPath && fs.existsSync(romPath)) {
  const rom = new Uint8Array(fs.readFileSync(romPath));
  const helloMBR = () => {
    const buf = new Uint8Array(512); let i = 0; const e = (...b) => { for (const x of b) buf[i++] = x; };
    e(0xFA,0x31,0xC0,0x8E,0xD8,0x8E,0xC0,0x8E,0xD0,0xBC,0x00,0x7C,0xBE,0x1D,0x7C,0xB4,0x0E,0xAC,0x84,0xC0,0x74,0x04,0xCD,0x10,0xEB,0xF7,0xF4,0xEB,0xFD);
    for (const ch of "Hello from Intel Atom PC!\r\nBoot OK - Halted.\r\n\0") e(ch.charCodeAt(0));
    buf[510] = 0x55; buf[511] = 0xAA; return buf;
  };
  const phys = (mb) => ((mb.cpu.sregs[1] << 4) + mb.cpu.ip) & 0xFFFFF;
  const bootRun = async (label, withDisk, ms) => {
    console.log(`\n[${label}]`);
    const mb = new Motherboard(stubCanvas, { ramMB: 16 });
    mb.setBIOSBinary(rom);
    if (withDisk) mb.loadDiskImage(0, helloMBR());
    const t0 = performance.now(); let leftAt = null;
    mb.powerOn();
    const iv = setInterval(() => { if (leftAt === null && mb.cycleCount > 2e6 && Math.abs(phys(mb) - 0xFE6B1) > 0x20) leftAt = performance.now() - t0; }, 20);
    await new Promise((r) => setTimeout(r, ms)); clearInterval(iv); mb.powerOff();
    const txt = screenText(mb);
    console.log(txt.split('\n').filter(Boolean).map((l) => '  |' + l).join('\n'));
    return { mb, txt };
  };
  let r = await bootRun('5c GLaBIOS real, sem disco', false, 6000);
  ok(r.mb._loopErrors === 0, 'nenhum erro de CPU (opcode não implementado etc.)');
  ok(r.txt.includes('640 KB OK'), 'RAM: 640 KB OK');
  ok(r.txt.includes('Video  [ CGA ]') && r.txt.includes('CPU    [ 8088 ]'), 'detecta vídeo CGA e CPU 8088');
  ok(!r.txt.includes('POST Error'), 'POST sem erro');
  ok(r.txt.includes('Disk Boot Fail'), 'sem disco: "Disk Boot Fail" (comportamento correto da BIOS)');
  ok(Math.abs(phys(r.mb) - 0xFE6B1) > 0x20, 'IP fora de 0xFE6B1');
  r = await bootRun('5d GLaBIOS real, com setor de boot', true, 6000);
  ok(r.mb._loopErrors === 0 && !r.txt.includes('POST Error'), 'POST limpo com disco');
  ok(r.txt.includes('Hello from Intel Atom PC!') && r.txt.includes('Boot OK - Halted.'), 'INT 19h → 0:7C00 → texto do MBR impresso via INT 10h da própria BIOS');
} else {
  console.log('\n[5c/5d] GLaBIOS real: ROM não informada — rode `node test-pit.mjs roms/GLABIOS_0.4.2_8P.ROM`');
}

console.log(fails ? `\n✘ ${fails} falha(s)` : '\n✔ todos os testes passaram');
process.exit(fails ? 1 : 0);
