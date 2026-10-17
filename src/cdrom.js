'use strict';
// ============================================================
// CD-ROM para o Intel Atom PC
//   1) CDImage        — ISO inteira num único Uint8Array; leitura de setor O(1), sem cópia
//   2) loadCdFrom*()  — carregamento rápido (streaming para buffer pré-alocado, com progresso)
//   3) IDEChannel     — canal IDE secundário (0x170-0x177, 0x376, IRQ 15) com drive ATAPI
//                       master, protocolo PIO. É o que drivers DOS (XCDROM, UDVD2…) procuram.
//
// Referências: ATA/ATAPI-6 (T13) — registradores, PACKET, IDENTIFY PACKET DEVICE;
//              SFF-8020i / MMC — comandos SCSI do pacote de 12 bytes.
// ============================================================

export const SECTOR = 2048;

const rd16 = (p, o) => (p[o] << 8) | p[o + 1];
const rd32 = (p, o) => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0;
const be16 = (v) => [(v >> 8) & 255, v & 255];
const be32 = (v) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
/** LBA → MSF (com o pregap de 150 setores do Red Book). */
const lbaToMsf = (lba) => { const f = lba + 150; return [0, Math.floor(f / 4500), Math.floor(f / 75) % 60, f % 75]; };
const ascii = (s, n) => { const o = []; for (let i = 0; i < n; i++) o.push(i < s.length ? s.charCodeAt(i) & 0x7F : 0x20); return o; };

// ------------------------------------------------------------
// Imagem
// ------------------------------------------------------------
export class CDImage {
  /** @param {Uint8Array} bytes imagem completa (setores de 2048 bytes — ISO 9660 / Mode 1) */
  constructor(bytes, name = 'cd.iso') {
    this.bytes = bytes;
    this.name = name;
    this.sectors = Math.floor(bytes.length / SECTOR);
  }
  /** ISO 9660: setor 16 = Primary Volume Descriptor ("\x01CD001"). */
  get isIso9660() {
    const o = 16 * SECTOR, b = this.bytes;
    return b.length > o + 6 && b[o] === 1 && b[o + 1] === 0x43 && b[o + 2] === 0x44 &&
           b[o + 3] === 0x30 && b[o + 4] === 0x30 && b[o + 5] === 0x31;
  }
  /** View (zero-copy, O(1)) de `count` setores a partir de `lba`. */
  read(lba, count = 1) {
    return this.bytes.subarray(lba * SECTOR, (lba + count) * SECTOR);
  }
}

/** Arquivo do <input type=file>: arrayBuffer() devolve o buffer sem cópia extra (File é lido de uma vez). */
export async function loadCdFromFile(file, onProgress) {
  if (onProgress) onProgress(0, file.size);
  const buf = await file.arrayBuffer();
  if (onProgress) onProgress(buf.byteLength, buf.byteLength);
  return new CDImage(new Uint8Array(buf), file.name);
}

/**
 * Download por streaming direto para um buffer do tamanho exato (Content-Length):
 * nenhum pico de memória dobrado (sem juntar chunks) e progresso para a UI.
 * Sem Content-Length, ou com Content-Encoding, cai no arrayBuffer() simples.
 */
export async function loadCdFromURL(url, onProgress, fetchFn = globalThis.fetch) {
  const res = await fetchFn(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const name = url.split('/').pop();
  const total = Number(res.headers.get('content-length')) || 0;
  const enc = res.headers.get('content-encoding');
  if (!res.body || !total || (enc && enc !== 'identity')) {
    const buf = await res.arrayBuffer();
    if (onProgress) onProgress(buf.byteLength, buf.byteLength);
    return new CDImage(new Uint8Array(buf), name);
  }
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > total) throw new Error('resposta maior que o Content-Length');
    out.set(value, got);
    got += value.length;
    if (onProgress) onProgress(got, total);
  }
  if (got !== total) throw new Error(`download incompleto (${got}/${total} bytes)`);
  return new CDImage(out, name);
}

// ------------------------------------------------------------
// Canal IDE com drive ATAPI (master). Slave ausente.
// ------------------------------------------------------------
const BSY = 0x80, DRDY = 0x40, DSC = 0x10, DRQ = 0x08, ERR = 0x01;

export class IDEChannel {
  /**
   * @param {object} o
   * @param {object} [o.pic]  recebe raiseIRQ(irq)/lowerIRQ(irq)
   * @param {number} [o.irq=15]  IRQ do canal secundário
   * @param {number} [o.base=0x170]
   * @param {number} [o.ctrl=0x376]
   */
  constructor({ pic = null, irq = 15, base = 0x170, ctrl = 0x376 } = {}) {
    this.pic = pic; this.irq = irq; this.base = base; this.ctrl = ctrl;
    this.image = null;
    this.unitAttention = false;
    this.pkt = new Uint8Array(12);
    this.reset();
  }

  // ---- mídia -----------------------------------------------------------
  /** Insere a imagem. Com `notify` (PC ligado) o 1º comando devolve UNIT ATTENTION (mídia trocada). */
  insert(image, notify = false) { this.image = image; if (notify) this.unitAttention = true; }
  eject() { this.image = null; this.unitAttention = true; }
  get hasMedia() { return !!this.image; }

  // ---- reset ------------------------------------------------------------
  /** Reset de hardware (power-on / RESET). Mantém a mídia. */
  reset() {
    this.drive = 0xA0; this.devCtl = 0; this.features = 0;
    this.srst = false; this.phase = 'idle';
    this.xfer = null; this.xpos = 0; this.chunkLeft = 0; this.limit = 0xFFFE; this.ppos = 0;
    this.sense = [0, 0, 0];
    this.unitAttention = false;
    this._signature(); this.error = 0x01; this.status = 0x00;
    if (this.pic) this.pic.lowerIRQ(this.irq);
  }
  /** Assinatura ATAPI: count=1, lba=1, cyl=0xEB14 (datasheet ATA/ATAPI-6, "Signature"). */
  _signature() { this.count = 1; this.lbaLo = 1; this.cylLo = 0x14; this.cylHi = 0xEB; }

  get _dev() { return (this.drive >> 4) & 1; }
  _irqRaise() { if (this.pic && !(this.devCtl & 0x02)) this.pic.raiseIRQ(this.irq); }
  _irqClear() { if (this.pic) this.pic.lowerIRQ(this.irq); }

  // ---- barramento de I/O --------------------------------------------------
  /** Escrita. `size` = 1/8 (byte), 16 (word), 32 (dword). */
  write(port, size, value) {
    if (port === this.ctrl) { this._writeCtl(value & 0xFF); return; }
    const r = port - this.base;
    if (r < 0 || r > 7) return;
    if (r === 6) { this.drive = value & 0xFF; return; }            // seleção de drive vale sempre
    if (this._dev !== 0) return;                                   // slave ausente
    if (r === 0) { this._writeData(size, value); return; }
    value &= 0xFF;
    switch (r) {
      case 1: this.features = value; break;
      case 2: this.count = value; break;
      case 3: this.lbaLo = value; break;
      case 4: this.cylLo = value; break;
      case 5: this.cylHi = value; break;
      case 7: this._command(value); break;
    }
  }

  read(port, size) {
    if (port === this.ctrl) return this._dev ? 0x00 : this.status;      // Alternate Status: não limpa a IRQ
    if (port === this.ctrl + 1) return 0xFF;
    const r = port - this.base;
    if (r < 0 || r > 7) return 0xFF;
    if (r === 6) return this.drive;
    if (this._dev !== 0) return 0x00;                                   // slave ausente
    switch (r) {
      case 0: return this._readData(size);
      case 1: return this.error;
      case 2: return this.count;
      case 3: return this.lbaLo;
      case 4: return this.cylLo;
      case 5: return this.cylHi;
      case 7: this._irqClear(); return this.status;                     // ler Status reconhece a IRQ
    }
    return 0xFF;
  }

  /** Device Control: bit1 nIEN, bit2 SRST. */
  _writeCtl(v) {
    const was = this.srst;
    this.devCtl = v & 0x0A;
    this.srst = !!(v & 0x04);
    if (this.srst) { this.status = BSY; return; }
    if (was) {                                                          // SRST 1→0: executa o reset de software
      const keep = this.devCtl, img = this.image;
      this.reset(); this.devCtl = keep; this.image = img;
    }
  }

  // ---- comandos ATA -------------------------------------------------------
  _command(cmd) {
    this._irqClear();
    this.error = 0;
    switch (cmd) {
      case 0x08: case 0x90:                                             // DEVICE RESET / EXECUTE DEVICE DIAGNOSTIC
        this._signature(); this.error = 0x01; this.status = 0x00; this.phase = 'idle'; return;
      case 0xA1:                                                        // IDENTIFY PACKET DEVICE
        this.limit = 0xFFFE; this._startData(this._identify()); return;
      case 0xA0:                                                        // PACKET
        if (this.features & 1) { this._abort(); return; }               // DMA não suportado → ABRT (host cai para PIO)
        this.limit = ((this.cylHi << 8) | this.cylLo) || 0xFFFE;
        if (this.limit & 1) this.limit--;
        if (this.limit < 2) this.limit = 2;
        this.ppos = 0; this.phase = 'packet';
        this.count = 0x01;                                              // CoD=1, IO=0: pronto para receber o pacote
        this.status = DRDY | DSC | DRQ;                                 // DRQ por polling (IDENTIFY word0 = 0x8580)
        return;
      case 0xEF: case 0xE0: case 0xE1: case 0xE6: case 0xE7:            // SET FEATURES, STANDBY/IDLE/SLEEP/FLUSH
        this.status = DRDY | DSC; this.phase = 'idle'; this._irqRaise(); return;
      case 0xE5:                                                        // CHECK POWER MODE
        this.count = 0xFF; this.status = DRDY | DSC; this.phase = 'idle'; this._irqRaise(); return;
      default:                                                          // inclui IDENTIFY DEVICE (0xEC) e READ SECTORS: ATAPI aborta
        this._abort();
    }
  }
  _abort() {
    this._signature(); this.error = 0x04; this.status = DRDY | DSC | ERR;
    this.phase = 'idle'; this._irqRaise();
  }

  /** IDENTIFY PACKET DEVICE: 256 words (datasheet ATA/ATAPI-6, tabela 28). */
  _identify() {
    const w = new Uint16Array(256);
    w[0] = 0x8580;                                  // ATAPI, tipo 5 (CD-ROM), removível, pacote de 12 bytes, DRQ por polling
    const str = (start, words, s) => { const a = ascii(s, words * 2); for (let i = 0; i < words; i++) w[start + i] = (a[2 * i] << 8) | a[2 * i + 1]; };
    str(10, 10, 'ATOMEMU-CD-0001');                // serial (20 chars)
    str(23, 4, '1.00');                            // firmware (8 chars)
    str(27, 20, 'ATOM-EMU Virtual CD-ROM');        // modelo (40 chars)
    w[49] = 0x0200;                                // LBA suportado
    w[53] = 0x0006;
    w[80] = 0x0078;                                // ATA/ATAPI-3 … 6
    w[82] = 0x0014;                                // NOP + PACKET
    const out = new Uint8Array(512);
    for (let i = 0; i < 256; i++) { out[2 * i] = w[i] & 255; out[2 * i + 1] = w[i] >> 8; }
    return out;
  }

  // ---- transferência de dados (PIO) ---------------------------------------
  _writeData(size, value) {
    if (this.phase !== 'packet') return;
    const n = size <= 8 ? 1 : size >= 32 ? 4 : 2;
    for (let i = 0; i < n && this.ppos < 12; i++) this.pkt[this.ppos++] = (value >>> (8 * i)) & 0xFF;
    if (this.ppos >= 12) { this.phase = 'busy'; this._execPacket(); }
  }

  _readData(size) {
    if (this.phase !== 'data') return size >= 32 ? 0xFFFFFFFF : 0xFFFF;
    const b = this.xfer, p = this.xpos;
    let v, n;
    if (size <= 8) { v = b[p] | 0; n = 1; }
    else if (size >= 32) { v = ((b[p] | 0) | ((b[p + 1] | 0) << 8) | ((b[p + 2] | 0) << 16) | ((b[p + 3] | 0) << 24)) >>> 0; n = 4; }
    else { v = (b[p] | 0) | ((b[p + 1] | 0) << 8); n = 2; }
    this.xpos += n; this.chunkLeft -= n;
    if (this.chunkLeft <= 0) { if (this.xpos >= b.length) this._complete(); else this._nextChunk(); }
    return v;
  }

  /** Inicia a fase de dados (host lê). `bytes` pode ser um subarray da imagem (sem cópia). */
  _startData(bytes) {
    this.xfer = bytes; this.xpos = 0;
    if (bytes.length === 0) { this._complete(); return; }
    this._nextChunk();
  }
  /** Um bloco DRQ: no máximo o "byte count limit" do host (par), informado em cyl lo/hi. */
  _nextChunk() {
    const left = this.xfer.length - this.xpos;
    let chunk = left <= this.limit ? left : (this.limit & ~1);
    this.chunkLeft = chunk;
    this.cylLo = chunk & 255; this.cylHi = (chunk >> 8) & 255;
    this.count = 0x02;                              // IO=1, CoD=0: dados para o host
    this.status = DRDY | DSC | DRQ;
    this.phase = 'data';
    this._irqRaise();
  }
  _complete() {                                      // fim do comando, sem erro
    this.count = 0x03; this.status = DRDY | DSC; this.phase = 'idle';
    this._irqRaise();
  }
  _good() { this.sense = [0, 0, 0]; this.error = 0; this._complete(); }
  _chk(key, asc, ascq) {                             // CHECK CONDITION
    this.sense = [key, asc, ascq];
    this.error = key << 4;
    this.count = 0x03; this.status = DRDY | DSC | ERR; this.phase = 'idle';
    this._irqRaise();
  }
  _dataIn(bytes, alloc, keepSense = false) {
    if (!keepSense) { this.sense = [0, 0, 0]; this.error = 0; }
    this._startData(bytes.subarray(0, Math.min(bytes.length, alloc)));
  }

  // ---- pacote SCSI/MMC ------------------------------------------------------
  _execPacket() {
    const p = this.pkt, op = p[0], img = this.image;

    if (op === 0x03) {                               // REQUEST SENSE
      const [k, a, q] = this.sense;
      this.sense = [0, 0, 0];
      this._dataIn(Uint8Array.from([0x70, 0, k, 0, 0, 0, 0, 10, 0, 0, 0, 0, a, q, 0, 0, 0, 0]), p[4], true);
      return;
    }
    if (op === 0x12) {                               // INQUIRY
      this._dataIn(Uint8Array.from([0x05, 0x80, 0x00, 0x21, 31, 0, 0, 0,
        ...ascii('ATOM-EMU', 8), ...ascii('VIRTUAL CD-ROM', 16), ...ascii('1.00', 4)]), p[4]);
      return;
    }
    if (this.unitAttention) { this.unitAttention = false; this._chk(6, 0x28, 0x00); return; }   // mídia trocada
    if (!img) { this._chk(2, 0x3A, 0x00); return; }                                             // sem mídia

    switch (op) {
      case 0x00: case 0x1E: case 0xBB: case 0x2B:    // TEST UNIT READY, PREVENT/ALLOW, SET CD SPEED, SEEK
        this._good(); return;
      case 0x1B:                                     // START STOP UNIT (LoEj=1,Start=0 → ejetar)
        if ((p[4] & 3) === 2) this.eject();
        this._good(); return;
      case 0x25:                                     // READ CAPACITY(10)
        this._dataIn(Uint8Array.from([...be32(img.sectors - 1), ...be32(SECTOR)]), 8); return;
      case 0x28: this._read(rd32(p, 2), rd16(p, 7)); return;          // READ(10)
      case 0xA8: this._read(rd32(p, 2), rd32(p, 6)); return;          // READ(12)
      case 0x43: this._readToc(p, img); return;
      case 0x42: {                                   // READ SUB-CHANNEL (sem áudio: status 0x15 = "não há status")
        const subq = !!(p[2] & 0x40);
        this._dataIn(Uint8Array.from(subq ? [0, 0x15, 0, 12, 1, 0x14, 1, 1, ...new Array(8).fill(0)] : [0, 0x15, 0, 0]), rd16(p, 7)); return;
      }
      case 0x46:                                     // GET CONFIGURATION: perfil atual = 0x0008 (CD-ROM)
        this._dataIn(Uint8Array.from([0, 0, 0, 4, 0, 0, 0, 0x08]), rd16(p, 7)); return;
      case 0x4A:                                     // GET EVENT STATUS NOTIFICATION: nenhum evento
        this._dataIn(Uint8Array.from([0, 2, 0x80, 0]), rd16(p, 7)); return;
      case 0x5A: this._modeSense(p); return;
      default: this._chk(5, 0x20, 0x00);             // ILLEGAL REQUEST / INVALID COMMAND OPERATION CODE
    }
  }

  _read(lba, n) {
    const img = this.image;
    if (lba + n > img.sectors) { this._chk(5, 0x21, 0x00); return; }   // LBA OUT OF RANGE
    if (n === 0) { this._good(); return; }
    const data = img.read(lba, n);
    this._dataIn(data, data.length);
  }

  /** READ TOC: formato 0 (TOC), 1 (multissessão). Sem áudio: faixa 1 de dados + lead-out (0xAA). */
  _readToc(p, img) {
    const msf = !!(p[1] & 2);
    const fmt = (p[2] & 0x0F) || (p[9] >> 6);
    const addr = (lba) => msf ? lbaToMsf(lba) : be32(lba);
    const first = p[6], alloc = rd16(p, 7);
    if (fmt === 1) {
      this._dataIn(Uint8Array.from([0, 10, 1, 1, 0, 0x14, 1, 0, ...addr(0)]), alloc); return;
    }
    if (fmt !== 0) { this._chk(5, 0x24, 0x00); return; }
    const d = [];
    if (first <= 1) d.push(0, 0x14, 1, 0, ...addr(0));
    if (first <= 1 || first === 0xAA) d.push(0, 0x14, 0xAA, 0, ...addr(img.sectors));
    if (!d.length) { this._chk(5, 0x24, 0x00); return; }
    this._dataIn(Uint8Array.from([...be16(d.length + 2), 1, 1, ...d]), alloc);
  }

  /** MODE SENSE(10): cabeçalho + página 0x2A (capacidades do CD). */
  _modeSense(p) {
    const page = p[2] & 0x3F;
    if (page !== 0x2A && page !== 0x3F) { this._chk(5, 0x24, 0x00); return; }
    const pg = [0x2A, 22, 0x00, 0x00, 0x01, 0x01, 0x29, 0x00, 0x05, 0x84, 0x01, 0x00, 0x00, 0x40, 0x05, 0x84,
                0, 0, 0, 0, 0, 0, 0, 0];
    const data = [...be16(pg.length + 6), 0x01, 0, 0, 0, 0, 0, ...pg];
    this._dataIn(Uint8Array.from(data), rd16(p, 7));
  }
}
