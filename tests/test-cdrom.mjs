// node test-cdrom.mjs [caminho/GLABIOS.ROM]
import { Motherboard } from '../src/motherboard.js';
import { CDImage, loadCdFromURL, loadCdFromFile } from '../src/cdrom.js';
import fs from 'node:fs';

let fails = 0;
const ok = (c, msg) => { console.log(`${c ? '  ✔' : '  ✘'} ${msg}`); if (!c) fails++; };
const stubCanvas = { getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const oc = console.log, ow = console.warn;

// ISO sintética: setor 16 = PVD "CD001"; cada setor começa com seu LBA (4 bytes) e um padrão
function makeIso(sectors) {
  const b = new Uint8Array(sectors * 2048);
  for (let s = 0; s < sectors; s++) {
    const o = s * 2048;
    b[o] = s & 255; b[o + 1] = (s >> 8) & 255; b[o + 2] = (s >> 16) & 255; b[o + 3] = 0xA5;
    for (let i = 4; i < 64; i++) b[o + i] = (s * 7 + i) & 255;
  }
  const pvd = 16 * 2048; b[pvd] = 1; b.set([0x43, 0x44, 0x30, 0x30, 0x31, 1], pvd + 1);
  return b;
}

const mb = new Motherboard(stubCanvas, { ramMB: 16 });
const IO = mb.cpu;
const B = 0x170;
const inb = (r) => IO.ioRead(B + r, 1) & 0xFF;
const outb = (r, v) => IO.ioWrite(B + r, 8, v);
const ST = () => inb(7);

// envia um pacote ATAPI e coleta TODA a resposta; devolve {data, chunks, status, error, count}
function packet(bytes, limit = 0xFFFE, features = 0) {
  outb(6, 0xA0); outb(1, features); outb(4, limit & 255); outb(5, limit >> 8); outb(7, 0xA0);
  if (features & 1) return { status: ST(), error: inb(1) };
  const p = Uint8Array.from([...bytes, ...new Array(12 - bytes.length).fill(0)]);
  if (!(ST() & 8) || inb(2) !== 1) return { fail: 'sem DRQ para receber o pacote', status: ST() };
  for (let i = 0; i < 12; i += 2) IO.ioWrite(B, 16, p[i] | (p[i + 1] << 8));
  const out = []; const chunks = [];
  while (ST() & 8) {
    const n = inb(4) | (inb(5) << 8); chunks.push(n);
    if (inb(2) !== 2) return { fail: 'ireason errado na fase de dados', status: ST() };
    for (let i = 0; i < n; i += 2) { const w = IO.ioRead(B, 16); out.push(w & 255); if (i + 1 < n) out.push(w >> 8); }
    if (out.length > 1 << 24) break;
  }
  return { data: Uint8Array.from(out), chunks, status: ST(), error: inb(1), count: inb(2) };
}
const sense = () => { const r = packet([0x03, 0, 0, 0, 18]); return [r.data[2], r.data[12], r.data[13]]; };
const str = (u, a, n) => String.fromCharCode(...u.subarray(a, a + n));

console.log('\n[1] Reset e assinatura ATAPI');
mb.cdrom.reset();
ok(inb(4) === 0x14 && inb(5) === 0xEB && inb(2) === 1 && inb(3) === 1, 'assinatura cyl=EB14, count=1, lba=1');
outb(6, 0xB0); ok(ST() === 0x00 && IO.ioRead(0x376, 1) === 0x00, 'slave selecionado: status 0x00 (ausente)');
outb(6, 0xA0);
ok(IO.ioRead(0x1F7, 1) === 0xFF, 'canal primário (0x1F0) não responde: status flutuante 0xFF');

console.log('\n[2] IDENTIFY PACKET DEVICE / IDENTIFY DEVICE');
{
  outb(6, 0xA0); outb(7, 0xA1);
  ok((ST() & 0x08) !== 0 && (inb(4) | inb(5) << 8) === 512, 'DRQ com 512 bytes');
  const w = []; for (let i = 0; i < 256; i++) w.push(IO.ioRead(B, 16));
  ok(w[0] === 0x8580, `word0 = 0x${w[0].toString(16)} (ATAPI, CD-ROM, removível, 12 bytes)`);
  const model = w.slice(27, 47).map((x) => String.fromCharCode(x >> 8, x & 255)).join('').trim();
  ok(model === 'ATOM-EMU Virtual CD-ROM', `modelo "${model}"`);
  ok(ST() === 0x50, `status final 0x${ST().toString(16)} (DRDY|DSC)`);
  outb(7, 0xEC);
  ok(ST() === 0x51 && inb(1) === 0x04 && inb(4) === 0x14 && inb(5) === 0xEB, 'IDENTIFY DEVICE (ATA) aborta e devolve a assinatura ATAPI');
}

console.log('\n[3] Sem mídia');
{
  let r = packet([0x00]);
  ok((r.status & 1) === 1, 'TEST UNIT READY → CHECK CONDITION');
  const s = sense(); ok(s[0] === 2 && s[1] === 0x3A, `REQUEST SENSE = NOT READY / medium not present (${s.map((x) => x.toString(16))})`);
  r = packet([0x12, 0, 0, 0, 36]);
  ok(r.data && r.data[0] === 5 && str(r.data, 8, 8) === 'ATOM-EMU', 'INQUIRY funciona sem mídia: tipo 5 (CD-ROM), "ATOM-EMU"');
}

console.log('\n[4] Com mídia (ISO sintética de 1000 setores)');
const iso = makeIso(1000);
mb.loadCdImage(new CDImage(iso, 'teste.iso'));
mb.cdrom.reset();
{
  let r = packet([0x00]); ok(!(r.status & 1) && r.status === 0x50, 'TEST UNIT READY ok');
  r = packet([0x25]); ok(r.data.length === 8 && ((r.data[0] << 24 | r.data[1] << 16 | r.data[2] << 8 | r.data[3]) >>> 0) === 999 && (r.data[6] << 8 | r.data[7]) === 2048, 'READ CAPACITY: último LBA 999, bloco 2048');
  r = packet([0x28, 0, 0, 0, 0, 16, 0, 0, 1]);
  ok(r.data.length === 2048 && str(r.data, 1, 5) === 'CD001', 'READ(10) LBA 16 → PVD "CD001"');
  r = packet([0x28, 0, 0, 0, 0, 100, 0, 0, 3], 2048);
  const exact = r.data.length === 6144 && [100, 101, 102].every((l, i) => r.data[i * 2048] === l && r.data[i * 2048 + 3] === 0xA5);
  ok(exact && r.chunks.join() === '2048,2048,2048', `READ(10) de 3 setores com limite 2048 → 3 blocos DRQ (${r.chunks})`);
  ok(r.status === 0x50 && r.count === 3, 'fim do comando: DRDY|DSC, ireason CoD|IO');
  r = packet([0xA8, 0, 0, 0, 3, 0xE7, 0, 0, 0, 1]);
  ok(r.data && r.data[0] === 0xE7 && r.data[1] === 3 && r.data[3] === 0xA5, 'READ(12) LBA 999 (0x3E7) → último setor, OK');
  r = packet([0x28, 0, 0, 0, 3, 0xE7, 0, 0, 2]);
  ok((r.status & 1) === 1, 'READ além do fim → CHECK CONDITION');
  const s = sense(); ok(s[0] === 5 && s[1] === 0x21, `REQUEST SENSE = ILLEGAL REQUEST / LBA out of range (${s.map((x) => x.toString(16))})`);
  r = packet([0x43, 2, 0, 0, 0, 0, 0, 0, 20]);
  ok(r.data[2] === 1 && r.data[3] === 1 && r.data[5] === 0x14 && r.data[6] === 1 && r.data[9] === 0 && r.data[10] === 2 && r.data[11] === 0, 'READ TOC (MSF): faixa 1 de dados começa em 00:02:00');
  const lo = r.data.subarray(12, 20);
  ok(lo[2] === 0xAA && lo[5] === 0 && lo[6] === 15 && lo[7] === 25, `lead-out (1000 setores + 150 de pregap = 1150) → MSF 00:${lo[6]}:${lo[7]} (esperado 00:15:25)`);
  r = packet([0x43, 0, 1, 0, 0, 0, 0, 0, 12]);
  ok(r.data.length === 12 && r.data[2] === 1 && r.data[3] === 1 && r.data[10] === 0, 'READ TOC formato 1 (multissessão): sessão 1 em LBA 0');
  r = packet([0x5A, 0, 0x2A, 0, 0, 0, 0, 0, 40]);
  ok(r.data && r.data[8] === 0x2A, 'MODE SENSE(10) página 0x2A (capacidades do CD)');
  r = packet([0x5A, 0, 0x01, 0, 0, 0, 0, 0, 40]);
  ok((r.status & 1) && sense()[1] === 0x24, 'MODE SENSE de página não suportada → INVALID FIELD');
  r = packet([0xFF]); ok((r.status & 1) && sense()[0] === 5, 'opcode desconhecido → ILLEGAL REQUEST');
  r = packet([0x28, 0, 0, 0, 0, 16, 0, 0, 1], 0xFFFE, 1);
  ok(r.status === 0x51 && r.error === 0x04, 'PACKET com bit DMA → ABRT (host cai para PIO)');
}

console.log('\n[5] IRQ 15 (nIEN) e mídia trocada');
{
  const irr = () => mb.pic.slave.irr & 0x80;
  mb.pic.slave.irr = 0; outb(6, 0xA0); IO.ioWrite(0x376, 8, 0x00);
  mb.pic.slave.irr = 0; outb(7, 0xA1); ok(irr() !== 0, 'IRQ15 levantada ao ter dados (nIEN=0)');
  inb(7); ok(irr() === 0, 'ler o Status reconhece e baixa a IRQ');
  while (ST() & 8) IO.ioRead(B, 16);
  IO.ioWrite(0x376, 8, 0x02); mb.pic.slave.irr = 0; outb(7, 0xA1);
  ok(irr() === 0, 'com nIEN=1 não há IRQ (driver por polling)');
  while (ST() & 8) IO.ioRead(B, 16);
  IO.ioWrite(0x376, 8, 0x00);
  mb.running = true; mb.loadCdImage(new CDImage(iso, 'trocada.iso')); mb.running = false;
  let r = packet([0x00]); ok((r.status & 1) && sense()[0] === 6, 'inserir com o PC ligado → UNIT ATTENTION (mídia trocada)');
  r = packet([0x00]); ok(r.status === 0x50, 'depois do UNIT ATTENTION o drive volta ao normal');
  IO.ioWrite(0x376, 8, 0x04); ok(ST() === 0x80, 'SRST=1 → BSY');
  IO.ioWrite(0x376, 8, 0x00); ok(inb(4) === 0x14 && inb(5) === 0xEB && ST() === 0x00 && mb.cdrom.hasMedia, 'SRST=0 → reset: assinatura ATAPI e a mídia continua');
}

console.log('\n[6] Loader por URL: streaming para buffer pré-alocado');
{
  const N = 64 * 1024 * 1024;
  const mk = (n, headers) => {
    let sent = 0;
    const stream = new ReadableStream({ pull(c) { if (sent >= n) { c.close(); return; }
      const len = Math.min(65536, n - sent), ch = new Uint8Array(len); for (let i = 0; i < len; i += 4096) ch[i] = (sent + i) >> 12; sent += len; c.enqueue(ch); } });
    return new Response(stream, { headers });
  };
  let progress = [];
  let t0 = performance.now();
  let img = await loadCdFromURL('disks/X.iso', (g, t) => progress.push([g, t]), async () => mk(N, { 'content-length': String(N) }));
  const dt = performance.now() - t0;
  ok(img.bytes.length === N && img.sectors === N / 2048 && img.name === 'X.iso', `64 MB carregados por streaming em ${dt.toFixed(0)} ms (${(N / 1048576 / (dt / 1000)).toFixed(0)} MB/s no Node)`);
  ok(progress.length > 100 && progress.every((p, i) => i === 0 || p[0] > progress[i - 1][0]) && progress.at(-1)[0] === N && progress.at(-1)[1] === N, `progresso monotônico até 100% (${progress.length} atualizações)`);
  ok(img.bytes[4096 * 5] === 5 && img.bytes[N - 4096] === ((N - 4096) >> 12) % 256, 'conteúdo íntegro (amostras nos dois extremos)');
  img = await loadCdFromURL('x.iso', null, async () => mk(1 << 20, {}));
  ok(img.bytes.length === 1 << 20, 'sem Content-Length: cai no arrayBuffer()');
  img = await loadCdFromURL('x.iso', null, async () => mk(1 << 20, { 'content-length': String(1 << 20), 'content-encoding': 'gzip' }));
  ok(img.bytes.length === 1 << 20, 'com Content-Encoding: não confia no Content-Length');
  let err = null; try { await loadCdFromURL('x.iso', null, async () => mk(1000, { 'content-length': '2000' })); } catch (e) { err = e.message; }
  ok(err && err.includes('incompleto'), `download truncado é detectado: "${err}"`);
  err = null; try { await loadCdFromURL('x.iso', null, async () => new Response('', { status: 404 })); } catch (e) { err = e.message; }
  ok(err === 'HTTP 404', 'HTTP 404 → erro');
  const f = new File([makeIso(40)], 'live.iso'); img = await loadCdFromFile(f, null);
  ok(img.sectors === 40 && img.isIso9660 && img.name === 'live.iso', 'loadCdFromFile (seletor de arquivo)');
}

console.log('\n[7] Imagem de 300 MB: acesso O(1), sem cópia');
{
  const SZ = 300 * 1024 * 1024;
  let big = null; try { big = new CDImage(new Uint8Array(SZ), 'grande.iso'); } catch (e) { ok(false, 'sem memória para 300 MB: ' + e.message); }
  if (big) {
    big.bytes[150000 * 2048 - 2048 + 7] = 0x77;
    const t0 = performance.now(); let sum = 0;
    for (let i = 0; i < 100000; i++) sum += big.read((i * 7919) % big.sectors, 1).length;
    const dt = performance.now() - t0;
    const v = big.read(150000 - 1, 1);
    ok(big.sectors === 153600 && v.buffer === big.bytes.buffer && v.length === 2048 && v[7] === 0x77, `${big.sectors} setores; read() devolve view do mesmo buffer (zero-copy)`);
    ok(dt < 200, `100 000 leituras de setor aleatórias em ${dt.toFixed(1)} ms (O(1), independe do tamanho)`);
  }
}

console.log('\n[8] Boot real da GLaBIOS: setor de boot lê o PVD do CD com a CPU emulada (OUT, REP OUTSW, REP INSW)');
const romPath = process.argv[2] || 'roms/GLABIOS_0.4.2_8P.ROM';
if (fs.existsSync(romPath)) {
  const m = new Motherboard(stubCanvas, { ramMB: 16 });
  m.setBIOSBinary(new Uint8Array(fs.readFileSync(romPath)));
  const bs = new Uint8Array(512); let i = 0; const e = (...b) => { for (const x of b) bs[i++] = x; };
  e(0xFA, 0x31, 0xC0, 0x8E, 0xD8, 0x8E, 0xC0, 0x8E, 0xD0, 0xBC, 0x00, 0x7C, 0xFB);
  e(0xBA, 0x76, 0x01, 0xB0, 0xA0, 0xEE);                 // mov dx,176; mov al,A0; out dx,al   (seleciona master)
  e(0xBA, 0x74, 0x01, 0xB0, 0x00, 0xEE);                 // byte count low = 0
  e(0xBA, 0x75, 0x01, 0xB0, 0x08, 0xEE);                 // byte count high = 8  (limite 2048)
  e(0xBA, 0x77, 0x01, 0xB0, 0xA0, 0xEE);                 // comando PACKET
  e(0xEC, 0xA8, 0x08, 0x74, 0xFB);                       // w1: in al,dx; test al,8; jz w1
  const pktFix = i + 1; e(0xBA, 0x70, 0x01, 0xBE, 0, 0, 0xB9, 0x06, 0x00, 0xF3, 0x6F);   // mov dx,170; mov si,pkt; mov cx,6; rep outsw
  e(0xBA, 0x77, 0x01, 0xEC, 0xA8, 0x08, 0x74, 0xFB);     // w2
  e(0xBA, 0x70, 0x01, 0xBF, 0x00, 0x80, 0xB9, 0x00, 0x04, 0xF3, 0x6D);                     // rep insw → ES:DI = 0:8000
  e(0xBE, 0x01, 0x80, 0xB4, 0x0E);                       // mov si,8001; mov ah,0E
  e(0xAC, 0xB4, 0x0E, 0xCD, 0x10, 0x81, 0xFE, 0x06, 0x80, 0x75, 0xF5);                     // imprime 5 bytes
  e(0xF4, 0xEB, 0xFD);
  const pkt = 0x7C00 + i; bs[pktFix + 3] = pkt & 255; bs[pktFix + 4] = pkt >> 8;
  e(0x28, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00);               // READ(10) LBA 16 × 1
  bs[510] = 0x55; bs[511] = 0xAA;
  m.loadDiskImage(0, bs);
  m.loadCdImage(new CDImage(makeIso(200), 'teste.iso'));
  console.log = () => {}; console.warn = () => {};
  m.powerOn(); await new Promise((r) => setTimeout(r, 3000)); m.powerOff();
  console.log = oc; console.warn = ow;
  let txt = ''; for (let y = 0; y < 25; y++) { let l = ''; for (let x = 0; x < 80; x++) { const c = m.mem.read8(0xB8000 + (y * 80 + x) * 2); l += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; } if (l.trim()) txt += '  |' + l.trimEnd() + '\n'; }
  oc(txt);
  ok(txt.includes('CD001'), 'CPU emulada leu o PVD "CD001" do CD pelo canal IDE secundário');
  ok(m._loopErrors === 0, `sem erros de CPU (${m._loopErrors})`);
} else oc('  (ROM não encontrada em ' + romPath + ' — teste 8 pulado)');

console.log(fails ? `\n✘ ${fails} falha(s)` : '\n✔ todos os testes do CD-ROM passaram');
process.exit(fails ? 1 : 0);
