'use strict';
// ============================================================
// Controlador de disquete NEC µPD765 (compatível com o 8272A do PC)
// ============================================================
// Portas do PC (base 0x3F0):
//   0x3F2 DOR  (escrita)  bit0-1 drive, bit2 /RESET, bit3 DMA/IRQ, bit4-7 motor
//   0x3F4 MSR  (leitura)  bit7 RQM, bit6 DIO (1 = FDC→CPU), bit4 BUSY, bit0-1 drive ocupado
//   0x3F5 FIFO (leitura/escrita) comandos, parâmetros, resultados
//   0x3F7 DIR  (leitura)  bit7 mudança de disco; CCR (escrita) taxa de dados (ignorada)
// Interrupção: IRQ6 sobe ao fim de SEEK/RECALIBRATE/READ/WRITE e é baixado por SENSE INTERRUPT STATUS.
// Transferência de dados: DMA 8237 canal 2 (página em 0x81 = page[1]) (modo "escrita na memória" para READ DATA, "leitura da memória"
// para WRITE DATA). Quando a contagem do DMA chega a zero, o terminal count é sinalizado no status do DMA.
// Referência: µPD765A / 8272A datasheets (NEC/Intel) — tabelas de comandos e fases de resultado.

const SECTOR_SIZE_OF = (n) => 128 << n;
const CMD_LEN = {                  // bytes de parâmetro (sem o byte de comando)
  0x03: 2, 0x04: 1, 0x07: 1, 0x08: 0, 0x0F: 2, 0x10: 0, 0x0E: 0, 0x12: 1, 0x13: 3,
  0x4A: 1, 0x0A: 1,
  0x06: 8, 0x46: 8, 0x66: 8, 0x26: 8, 0xC6: 8,   // READ DATA (MFM/MT/SK)
  0x05: 8, 0x45: 8, 0xC5: 8,                      // WRITE DATA
  0x0C: 8, 0x4C: 8,                               // READ DELETED / (não usado no PC)
  0x0D: 5, 0x4D: 5,                               // FORMAT TRACK
};
const isRead = (c) => (c & 0x1F) === 0x06 || (c & 0x1F) === 0x0C;
const isWrite = (c) => (c & 0x1F) === 0x05;

export class FDC765 {
  /**
   * @param {object} o
   * @param {object} o.dma   DMA8237 (canal 2 = floppy)
   * @param {object} o.pic   PIC8259 (IRQ6)
   * @param {object} o.mem   Memory (write8/read8)
   * @param {object} o.media função () => { read(lba,n) → Uint8Array, write(lba, bytes), sectors } ou null
   */
  constructor({ dma, pic, mem, media }) {
    this.dma = dma; this.pic = pic; this.mem = mem; this.media = media;
    this.reset(true);
  }

  reset(power = false) {
    this.dor = 0x0C;                       // /RESET=1, DMA habilitado, motor off
    this.cmd = []; this.need = 0;          // fase de comando
    this.res = []; this.resPos = 0;        // fase de resultado
    this.busy = false;
    this.pendingInt = false;               // interrupção aguardando SENSE INTERRUPT STATUS
    this.st0 = 0; this.pcn = [0, 0, 0, 0]; // por drive
    this.dirtyReset = power;
    // reset por DOR: uma interrupção por unidade (4); cada SENSE INTERRUPT devolve C0h|unidade (ready/polling)
    this.resetPending = power ? 0 : 4;
    if (!power) this._raiseIrq();
  }

  _raiseIrq() { this.pendingInt = true; if (this.pic) this.pic.raiseIRQ(6); }
  _dropIrq() { this.pendingInt = false; if (this.pic) this.pic.lowerIRQ(6); }

  // ---- registradores ------------------------------------------------------
  /** Leitura MSR: RQM=1 quando pronto; DIO=1 quando há resultado para a CPU. */
  msr() {
    if (this.res.length > this.resPos) return 0xD0 | (this.busy ? 0x10 : 0);   // RQM|DIO|BUSY
    if (this.busy) return 0x90 | 0x10;                                          // RQM|BUSY (fase de comando)
    return 0x80;                                                                // RQM, pronto
  }
  read(port) {
    switch (port & 7) {
      case 2: return this.dor;                                // 0x3F2 (leitura de DOR)
      case 4: return this.msr();                              // 0x3F4
      case 5: return this._readFifo();                        // 0x3F5
      case 7: return this.media && this.media() ? 0x00 : 0x00; // 0x3F7 DIR: sem troca de disco
      default: return 0xFF;
    }
  }
  write(port, v) {
    v &= 0xFF;
    switch (port & 7) {
      case 2: {                                               // DOR
        const wasReset = !(this.dor & 0x04), nowReset = !(v & 0x04);
        this.dor = v;
        if (!wasReset && nowReset) this.reset(false);         // bit2 baixo = reset do controlador
        break;
      }
      case 5: this._writeFifo(v); break;                      // 0x3F5
      default: break;                                         // 0x3F7 CCR: taxa ignorada
    }
  }

  _writeFifo(v) {
    if (this.res.length > this.resPos) return;                // ainda com resultado pendente: ignora
    if (!this.busy) {                                         // primeiro byte = comando
      this.cmd = [v];
      const op = v & 0x1F;
      const base = CMD_LEN[v] ?? CMD_LEN[v & 0x7F] ?? CMD_LEN[op];
      if (base === undefined) { this.res = [0x80]; this.resPos = 0; return; }   // comando inválido: ST0=80h
      this.need = base; this.busy = true;
      if (this.need === 0) this._execute();
      return;
    }
    this.cmd.push(v);
    if (this.cmd.length - 1 >= this.need) this._execute();
  }

  _readFifo() {
    if (this.res.length > this.resPos) {
      const b = this.res[this.resPos++];
      if (this.resPos >= this.res.length) { this.res = []; this.resPos = 0; }
      return b;
    }
    return 0x00;
  }

  // ---- execução -----------------------------------------------------------
  _execute() {
    const cmd = this.cmd[0], op = cmd & 0x1F, p = this.cmd.slice(1);
    this.busy = false;
    if (op === 0x03) {                                        // SPECIFY (taxa/tempos: aceitos, sem efeito)
      this.res = []; return;
    }
    if (op === 0x04) {                                        // SENSE DRIVE STATUS
      const drv = p[0] & 3;                                   // ST3: HD, drive ready, track0, two-sided
      this.res = [((p[0] & 4) ? 4 : 0) | (drv === 0 ? 0x10 : 0) | 0x20 | 0x08 | drv];
      this.resPos = 0; return;
    }
    if (op === 0x07) {                                        // RECALIBRATE
      const drv = p[0] & 3; this.pcn[drv] = 0; this.st0 = 0x20 | drv;
      this._raiseIrq(); this.res = []; return;
    }
    if (op === 0x0F) {                                        // SEEK
      const drv = p[0] & 3; this.pcn[drv] = p[1]; this.st0 = 0x20 | drv;
      this._raiseIrq(); this.res = []; return;
    }
    if (op === 0x08) {                                        // SENSE INTERRUPT STATUS
      if (!this.pendingInt) { this.res = [0x80]; this.resPos = 0; return; }   // sem interrupção: ST0=80h
      if (this.resetPending > 0) {                            // pós-reset: uma interrupção por unidade
        const drv = 4 - this.resetPending; this.resetPending--;
        this.res = [0xC0 | drv, 0]; this.resPos = 0;
        if (this.resetPending === 0) this._dropIrq();
        return;
      }
      this._dropIrq();
      this.res = [this.st0, this.pcn[this.st0 & 3]]; this.resPos = 0; return;
    }
    if (op === 0x10) { this.res = [0x90]; this.resPos = 0; return; }        // VERSION: 765A/8272A
    if (op === 0x0E) { this.res = [0x80]; this.resPos = 0; return; }        // DUMPREG: não suportado
    if (op === 0x12 || op === 0x13 || op === 0x0A || op === 0x4A) {         // PERPENDICULAR/CONFIGURE/READ ID
      if (op === 0x4A) { this._readId(p[0] & 3); return; }
      this.res = []; return;
    }
    if (isRead(cmd)) { this._readData(cmd, p); return; }
    if (isWrite(cmd)) { this._writeData(cmd, p); return; }
    this.res = [0x80]; this.resPos = 0;                       // não implementado aqui
  }

  /** READ ID: devolve C/H/R/N do próximo setor da trilha atual (aqui: setor 1). */
  _readId(drv) {
    const h = (this.dor >> 2) & 1;
    this.st0 = (h << 2) | drv;
    this.res = [this.st0, 0, 0, this.pcn[drv], h, 1, 2];
    this.resPos = 0; this._raiseIrq();
  }

  /** Converte C/H/R em LBA (geometria 80/2/18). Retorna -1 se fora. */
  _lba(c, h, r, spt = 18, heads = 2, cyls = 80) {
    if (c >= cyls || h >= heads || r < 1 || r > spt) return -1;
    return (c * heads + h) * spt + (r - 1);
  }

  _readData(cmd, p) {
    const [hdr, c, h, r, n, eot] = [p[0], p[1], p[2], p[3], p[4], p[5]];
    const drv = hdr & 3, head = (hdr >> 2) & 1;
    const media = this.media ? this.media() : null;
    const ch = this.dma.ch[2];
    const sz = SECTOR_SIZE_OF(n);
    if (!media) { this._abnormal(drv, head, c, h, r, n, 0x40, 0x01); return; }   // sem disco: ND
    let cc = c, hh = head, rr = r, lba = this._lba(cc, hh, rr);
    if (lba < 0 || (this.dma.mask >> 2) & 1) { this._abnormal(drv, head, c, h, r, n, 0x40, 0x04); return; }
    let transferred = 0, lastC = c, lastH = h, lastR = r;
    // o DMA diz quantos bytes cabem: (count programado + 1)
    const total = (ch.baseCount & 0xFFFF) + 1;
    while (transferred < total) {
      const data = media.read(lba, 1);
      if (!data) { this._abnormal(drv, head, cc, hh, rr, n, 0x40, 0x04); return; }
      const chunk = Math.min(sz, total - transferred);
      const linear = ((this.dma.page[1] << 16) | (ch.curAddr & 0xFFFF)) >>> 0;
      for (let i = 0; i < chunk; i++) this.mem.write8((linear + i) & 0xFFFFF, data[i]);
      ch.curAddr = (ch.curAddr + chunk) & 0xFFFF;
      transferred += chunk;
      lastC = cc; lastH = hh; lastR = rr;
      if (rr >= eot) { rr = 1; if (hh === 0) hh = 1; else { hh = 0; cc++; } }   // avança setor/cabeça/cilindro
      else rr++;
      lba = this._lba(cc, hh, rr);
      if (transferred < total && lba < 0) break;               // fim do disco
    }
    ch.curCount = 0xFFFF; this.dma.status |= 1 << 2;             // terminal count do canal 2
    this.st0 = (head << 2) | drv;
    this.res = [this.st0, 0, 0, lastC, lastH, lastR, n];
    this.resPos = 0; this._raiseIrq();
  }

  _writeData(cmd, p) {
    const [hdr, c, h, r, n, eot] = [p[0], p[1], p[2], p[3], p[4], p[5]];
    const drv = hdr & 3, head = (hdr >> 2) & 1;
    const media = this.media ? this.media() : null;
    const ch = this.dma.ch[2];
    const sz = SECTOR_SIZE_OF(n);
    if (!media || !media.write) { this._abnormal(drv, head, c, h, r, n, 0x40, 0x02); return; }   // protegido/sem disco
    let cc = c, hh = head, rr = r, lba = this._lba(cc, hh, rr);
    if (lba < 0) { this._abnormal(drv, head, c, h, r, n, 0x40, 0x04); return; }
    const total = (ch.baseCount & 0xFFFF) + 1;
    let transferred = 0, lastC = c, lastH = h, lastR = r;
    while (transferred < total) {
      const chunk = Math.min(sz, total - transferred);
      const linear = ((this.dma.page[1] << 16) | (ch.curAddr & 0xFFFF)) >>> 0;
      const buf = new Uint8Array(sz);
      for (let i = 0; i < chunk; i++) buf[i] = this.mem.read8((linear + i) & 0xFFFFF);
      media.write(lba, buf);
      ch.curAddr = (ch.curAddr + chunk) & 0xFFFF;
      transferred += chunk;
      lastC = cc; lastH = hh; lastR = rr;
      if (rr >= eot) { rr = 1; if (hh === 0) hh = 1; else { hh = 0; cc++; } } else rr++;
      lba = this._lba(cc, hh, rr);
      if (transferred < total && lba < 0) break;
    }
    ch.curCount = 0xFFFF; this.dma.status |= 1 << 2;
    this.st0 = (head << 2) | drv;
    this.res = [this.st0, 0, 0, lastC, lastH, lastR, n];
    this.resPos = 0; this._raiseIrq();
  }

  /** Término anormal: ST0 com IC=01 (40h), ST1/ST2 com o motivo. */
  _abnormal(drv, head, c, h, r, n, ic, st1) {
    this.st0 = ic | (head << 2) | drv;
    this.res = [this.st0, st1, 0, c, h, r, n];
    this.resPos = 0; this._raiseIrq();
  }
}
