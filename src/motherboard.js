'use strict';

import { CPU, IF, TF } from './cpu.js';
import { XMS, XMS_TRAP_INT } from './xms.js';
import { FDC765 } from './fdc.js';
import { Memory, ATXPowerSupply } from './chipset.js';
import { VGA, Keyboard, IDEDisk, PIC8259, PIT8254, MonotonicClock, DMA8237, PPI8255, UART16550, ParallelPort } from './devices.js';
import { installBIOS, buildMinimalBIOSRom, loadBIOSInto } from './bios.js';
import { IDEChannel } from './cdrom.js';

export class Motherboard {
  constructor(canvas, opts = {}) {
    this.ramMB = opts.ramMB || 16;
    this.hddMB = opts.hddMB || 4;

    this.mem = new Memory(this.ramMB * 1024 * 1024);
    this.psu = new ATXPowerSupply();

    this.vga = new VGA(this.mem, canvas);
    this.kbd = new Keyboard();
    this.disk = new IDEDisk(this.hddMB);
    this.pic = new PIC8259();
    // Relógio do PIT: performance.now() + interpolação por instruções executadas
    // (evita contador "congelado" quando performance.now() é arredondado).
    this.cycleCount = 0;
    this.clock = new MonotonicClock({ steps: () => this.cycleCount });
    this.pit = new PIT8254(this.pic, this.clock);
    this.vga.clock = this.clock;       // status de retrace do CGA (0x3DA) usa o mesmo relógio
    this.dma = new DMA8237();
    this.floppy = { data: null };                                  // imagem do disquete A: (1,44 MB)
    this.fdc = new FDC765({ dma: this.dma, pic: this.pic, mem: this.mem,
                            media: () => this._floppyMedia() });    // µPD765: portas 0x3F0-0x3F7, IRQ6, DMA 2
    this.uart = new UART16550();              // COM1 (0x3F8)
    this.lpt = new ParallelPort();            // LPT1 (0x378)
    this.ppi = new PPI8255({ pit: this.pit, kbd: this.kbd });   // PC/XT: portas 0x60-0x63
    // Canal IDE secundário (0x170-0x177, 0x376, IRQ15) com drive ATAPI CD-ROM master
    this.cdrom = new IDEChannel({ pic: this.pic, irq: 15 });
    this.kbd.pic = this.pic;

    this.cpu = new CPU(this.mem);
    this.xms = new XMS(this.mem, this.cpu);   // XMS 3.0 em JS (memória acima de 1 MB para HimemX-less DOS)

    // ============================================================
    // I/O ports — mapeamento completo
    // ============================================================
    this._port61 = 0x00;

    this.cpu.ioWrite = (port, size, value) => {
      // VGA (0x3B0-0x3DF)
      if (port >= 0x3B0 && port <= 0x3DF) {
        this.vga.write(port, value);
        return;
      }
      // PIC mestre (0x20, 0x21) e escravo (0xA0, 0xA1)
      if (port === 0x20 || port === 0x21 || port === 0xA0 || port === 0xA1) {
        this.pic.write(port, value);
        return;
      }
      // PIT 8254 (0x40-0x43; o chip decodifica só A0/A1, então 0x44-0x5F espelham)
      if (port >= 0x40 && port <= 0x5F) {
        this.pit.write(port, value);
        return;
      }
      // PPI 8255 (PC/XT): 0x60 A, 0x61 B (GATE2/speaker), 0x62 C, 0x63 controle
      if (port >= 0x60 && port <= 0x63) { this.ppi.write(port, value); return; }
      if (port === 0x64) { this.kbd.write(port, value); return; }
      // CMOS/RTC (0x70, 0x71) — stub
      if (port === 0x70 || port === 0x71) return;
      // DMA 8237 (0x00-0x0F, 0x81-0x8F)
      if (port <= 0x0F || (port >= 0x80 && port <= 0x8F)) { this.dma.write(port, value); return; }
      // IDE secundário / CD-ROM ATAPI (0x170-0x177, controle 0x376-0x377)
      if ((port >= 0x170 && port <= 0x177) || port === 0x376 || port === 0x377) {
        this.cdrom.write(port, size, value);
        return;
      }
      // COM1 (UART 16550A) e LPT1 (porta paralela)
      if (port >= 0x3F0 && port <= 0x3F7) { this.fdc.write(port, value); return; }
      if (port >= 0x3F8 && port <= 0x3FF) { this.uart.write(port, value); return; }
      if (port >= 0x378 && port <= 0x37A) { this.lpt.write(port, value); return; }
      // Porta 0x92 — System Control Port A
      if (port === 0x92) return;
    };

    this.cpu.ioRead = (port, size) => {
      // VGA
      if (port >= 0x3B0 && port <= 0x3DF) return this.vga.read(port);
      // PIC
      if (port === 0x20 || port === 0x21 || port === 0xA0 || port === 0xA1) {
        return this.pic.read(port);
      }
      // PIT — canais 0/1/2; 0x43 é write-only (read() devolve 0xFF)
      if (port >= 0x40 && port <= 0x5F) {
        return this.pit.read(port);
      }
      // PPI 8255 (PC/XT) e status legado do teclado (0x64)
      if (port >= 0x60 && port <= 0x63) return this.ppi.read(port);
      if (port === 0x64) return this.kbd.read(port);
      // CMOS — devolve 0 (stub)
      if (port === 0x70) return 0xFF;
      if (port === 0x71) return 0x00;
      // IDE secundário / CD-ROM ATAPI (a porta de dados 0x170 é lida em 16/32 bits)
      if ((port >= 0x170 && port <= 0x177) || port === 0x376 || port === 0x377) {
        return this.cdrom.read(port, size);
      }
      // COM1 / LPT1
      if (port >= 0x3F0 && port <= 0x3F7) return this.fdc.read(port);
      if (port >= 0x3F8 && port <= 0x3FF) return this.uart.read(port);
      if (port >= 0x378 && port <= 0x37A) return this.lpt.read(port);
      // Porta 0x92
      if (port === 0x92) return 0x00;
      // DMA 8237 + registradores de página
      if (port <= 0x0F || (port >= 0x80 && port <= 0x8F)) return this.dma.read(port);
      // Default
      return 0xFF;
    };

    // Handlers JS para INT 10h/13h/16h/19h/1Ah
    installBIOS({
      cpu: this.cpu, mem: this.mem, vga: this.vga,
      kbd: this.kbd, disk: this.disk,
    });

    this._jsIntHandler = this.cpu.intHandler;   // HLE das INTs (usado só com a ROM stub e p/ INT 13h)

    // Hook do framebuffer VGA
    const origWrite8  = this.mem.write8.bind(this.mem);
    const origWrite16 = this.mem.write16.bind(this.mem);
    const origWrite32 = this.mem.write32.bind(this.mem);
    const FB_START = 0xB8000;
    const FB_END   = 0xB8000 + 80 * 25 * 2;
    const inFB = (a, size) => (a + size > FB_START && a < FB_END);

    this.mem.write8  = (a, v) => { origWrite8(a, v);  if (inFB(a, 1)) this.vga.markDirty(); };
    this.mem.write16 = (a, v) => { origWrite16(a, v); if (inFB(a, 2)) this.vga.markDirty(); };
    this.mem.write32 = (a, v) => { origWrite32(a, v); if (inFB(a, 4)) this.vga.markDirty(); };

    // ROM BIOS
    this.biosBinary = opts.biosBinary || null;

    // Estado
    this.running = false;
    this.cycleCount = 0;
    this.currentKHz = 0;
    this._lastFrame = 0;
    this._lastCycles = 0;
    this.onDiskActivity = null;
    this.diskLoaded = false;
    this.hleDisk = opts.hleDisk === true;    // INT 13h em JS só se pedido (padrão: ROM real + µPD765)

    // Diagnóstico
    this._loopIterations = 0;
    this._loopErrors = 0;
  }

  setBIOSBinary(binary) {
    this.biosBinary = binary;
    console.log(`[BIOS] Imagem externa definida: ${binary.length} bytes`);
  }

  powerOn() {
    this.psu.plugIn();
    this.psu.turnOn();

    // Carrega ROM BIOS
    const rom = this.biosBinary || buildMinimalBIOSRom();
    if (!this.biosBinary) {
      console.warn('[BIOS] Usando stub mínimo.');
    }
    loadBIOSInto(this.mem, rom);

    // Estado pós-RESET
    this.cpu.regs.fill(0);
    this.cpu.sregs.fill(0);
    this.cpu.sregs[1] = 0xF000;
    this.cpu.ip       = 0xFFF0;
    this.cpu.flags    = 0x0002;
    this.cpu.halted   = false;
    this.cpu.osize    = 16;
    this.cpu.asize    = 16;
    this.cpu.segOvr   = -1;
    this.cpu.rep      = 0;

    // Limpa tela
    for (let i = 0; i < 80 * 25; i++) {
      this.mem.write8(0xB8000 + i * 2, 0x20);
      this.mem.write8(0xB8000 + i * 2 + 1, 0x07);
    }
    this.vga.cursorPos = 0;
    this.vga.markDirty();

    // ROM real: INTs vão pela IVT (código da BIOS) e o teclado fala o protocolo XT.
    // ROM stub interna: mantém os handlers JS (HLE) e o teclado legado.
    if (this.biosBinary) {
      // SW1 b0 = 0 (sem FDC): a BIOS não testa o NEC 765, que ainda não é emulado. O INT 13h em HLE
      // continua servindo o drive A: para o INT 19h, então a imagem carregada ainda dá boot.
      this.ppi.sw1 &= ~0xC1;
      if (this.floppy.data) this.ppi.sw1 |= 0x01;                    // IPL: unidade de disquete anunciada só com imagem (sem mídia → sem sondagem do FDC)
      this.cpu.intHandler = (vec) => this._romInt(vec);
      this.kbd.resetXT();
    } else {
      // INT 13h pelo mesmo _int13 da ROM real (geometria de disquete 80/2/18, validada em todos os setores);
      // o handler antigo do stub assumia disco rígido (16 cabeças × 63 setores).
      this.cpu.intHandler = (vec) => { if (vec === 0x13) this._int13(); else if (!this._hleCommon(vec)) this._jsIntHandler.call(this.cpu, vec); };
      this.kbd.xt = false;
    }

    // Reset de periféricos temporizados
    this.pic.reset();
    this.pit.reset();
    this.cdrom.reset();
    this.dma.reset();
    this.fdc.reset(true);
    this.uart.reset();
    this.lpt.reset();
    this.ppi.reset();
    this.xms.reset();
    this.xms.installStub();                   // entrada FAR do XMS em EF00:0000
    this._port61 = 0x00;

    // Reset contadores
    this.cycleCount = 0;
    this._loopIterations = 0;
    this._loopErrors = 0;

    this.crashed = false;
    this.running = true;
    this._lastFrame = performance.now();
    this._lastCycles = 0;
    console.log('[MB] powerOn() — iniciando _loop');
    this._loop();
  }

  powerOff() {
    console.log('[MB] powerOff()');
    this.psu.turnOff();
    this.running = false;
  }

  reset() {
    this.running = false;
    this.psu.reset();
    setTimeout(() => this.powerOn(), 150);
  }

  /**
   * Insere uma imagem de CD (CDImage) no drive ATAPI. Com o PC ligado o drive avisa
   * "mídia trocada" (UNIT ATTENTION) no próximo comando; o ideal é dar RESET.
   */
  loadCdImage(image) {
    if (!image.isIso9660) console.warn(`[CD] ${image.name}: setor 16 sem "CD001" — não parece ISO 9660`);
    this.cdrom.insert(image, this.running);
  }
  ejectCd() { this.cdrom.eject(); }

  loadDiskImage(sector, bytes) {
    if (sector === 0 && bytes.length === 1474560) this.floppy.data = new Uint8Array(bytes);   // disquete A:
    this.diskLoaded = true;                    // há mídia: o HLE de INT 13h passa a servir o drive A:
    const limit = Math.min(bytes.length, this.disk.data.length - sector * 512);
    this.disk.data.set(bytes.subarray(0, limit), sector * 512);
  }

  /** Meio do disquete A: para o controlador: leitura/escrita de setores de 512 bytes. */
  _floppyMedia() {
    const f = this.floppy;
    if (!f.data) return null;
    return {
      read: (lba, n) => f.data.slice(lba * 512, (lba + n) * 512),
      write: (lba, buf) => f.data.set(buf.subarray(0, 512), lba * 512),
    };
  }

  bindInput(el) {
    el.addEventListener('keydown', (e) => {
      if (this.kbd.keyDown(e.code)) e.preventDefault();
    });
    el.addEventListener('keyup', (e) => {
      if (this.kbd.keyUp(e.code)) e.preventDefault();
    });
  }

  // ============================================================
  // LOOP PRINCIPAL — blindado
  // ============================================================
  /**
   * Entrega uma IRQ de hardware: o 8259 já fez o INTA (getPending) e devolveu
   * o vetor. Sequência de INT do 8086: push FLAGS, CS, IP; IF=TF=0; CS:IP = IVT[vec].
   * (Despacha pela IVT, ou seja, executa a ISR da própria ROM — ex.: INT 08h
   * da GLaBIOS — em vez do intHandler JS, que só conhece INT 10h/13h/16h/19h/1Ah.)
   */
  _deliverIRQ(vec) {
    const m = this.mem;
    if (m.read16(vec * 4) === 0 && m.read16(vec * 4 + 2) === 0) return;   // IVT ainda vazia
    if (this.crashed) return;
    this.cpu.halted = false;                     // IRQ acorda HLT
    this._vector(vec);
  }

  /** Sequência de INT do 8086: push FLAGS, CS, IP; IF=TF=0; CS:IP = IVT[vec]. */
  _vector(vec) {
    const c = this.cpu, m = this.mem;
    const off = m.read16(vec * 4), seg = m.read16(vec * 4 + 2);
    c.osize = 16;
    c.push(c.flags & 0xFFFF);
    c.push(c.sregs[1]);
    c.push(c.ip & 0xFFFF);
    c.setF(IF, 0); c.setF(TF, 0);
    c.sregs[1] = seg;
    c.ip = off;
  }

  /**
   * INT n de software com a ROM real: executa o handler da PRÓPRIA BIOS via IVT
   * (INT 10h/16h/1Ah etc. são código da GLaBIOS). Única exceção: INT 13h, porque
   * ainda não há FDC/XT-IDE emulado — o disco é servido pelo HLE em JS (bios.js),
   * como faria uma option ROM que assume o vetor 13h.
   */
  /** Serviços em alto nível comuns à ROM real e ao stub: XMS (INT 2Fh, INT F2h) e memória estendida (INT 15h). */
  _hleCommon(vec) {
    if (vec === 0x2F) return this.xms.int2f();
    if (vec === 0x15) return this.xms.int15();
    if (vec === 0x4B) return this.xms.int4b();
    if (vec === XMS_TRAP_INT) { this.xms.call(); return true; }
    return false;
  }

  _romInt(vec) {
    // INT 13h: disquete de 1,44 MB → ROM real + µPD765. Sem disquete (só HDD / imagem não-disquete) → atendimento
    // em JavaScript, porque o disco rígido da GLaBIOS é o controlador XT (WD1002, 0x320), que não está emulado.
    if (vec === 0x13 && (this.hleDisk || !this.floppy.data)) { this._int13(); return; }
    if (this._hleCommon(vec)) return;
    this._vector(vec);
  }

  /**
   * HLE do INT 13h (serviços de disco) para a ROM real, enquanto não existe
   * FDC 765 / XT-IDE emulado. Com imagem carregada expõe o drive A: como disquete
   * de 1,44 MB (80 cil × 2 cabeças × 18 setores); sem imagem, ou para outros
   * drives, responde "timeout" (AH=80h, CF=1) como um drive ausente — assim a
   * GLaBIOS cai em "Disk Boot Fail" em vez de executar um setor de zeros.
   * Retorna ao programa chamador alterando AH/CF direto (equivale a um IRET).
   */
  _int13() {
    const c = this.cpu, m = this.mem;
    const ax = c.r16(0), ah = ax >> 8, al = ax & 0xFF, cx = c.r16(1), dx = c.r16(2);
    const CYL = 80, HEADS = 2, SPT = 18;
    // Diário dos últimos INT 13h (consulte no console: mb.int13Log.slice(-20)); erros também vão para o console.
    const log = (this.int13Log ||= []);
    const entry = { ah, al, cyl: ((cx >> 8) & 0xFF) | ((cx & 0xC0) << 2), head: dx >> 8, sec: cx & 0x3F, dl: dx & 0xFF,
                    es: c.sregs[0], bx: c.r16(3), cs: c.sregs[1], ip: c.ip, status: 0 };
    log.push(entry); if (log.length > 256) log.shift();
    const done = (code, extraAL) => {
      entry.status = code;
      if (code && entry.dl < 0x80 && (this._int13Errs = (this._int13Errs || 0) + 1) <= 20) {   // sondas ao HD (DL≥80) são normais
        if (this._int13Errs === 1) {
          console.warn('[INT13] últimas chamadas antes do 1º erro:\n' + log.slice(-12).map((e) =>
            `  AH=${e.ah.toString(16)} AL=${e.al} CHS=${e.cyl}/${e.head}/${e.sec} DL=${e.dl} ES:BX=${e.es.toString(16)}:${e.bx.toString(16)} → ${e.status ? '0x' + e.status.toString(16) : 'ok'}`).join('\n'));
        }
        console.warn(`[INT13] erro 0x${code.toString(16)}: AH=${ah.toString(16)} AL=${al} CHS=${entry.cyl}/${entry.head}/${entry.sec} DL=${entry.dl} ES:BX=${entry.es.toString(16)}:${entry.bx.toString(16)} (chamado de ${entry.cs.toString(16)}:${entry.ip.toString(16)})`);
      }
      c.w8(4, code);                                   // AH = status
      if (extraAL !== undefined) c.w8(0, extraAL);     // AL
      c.setF(1, code ? 1 : 0);                         // CF
      m.write8(0x441, code);                           // BDA 40:41 = último status
    };
    if (!this.diskLoaded || (dx & 0xFF) !== 0) return done(0x80);       // drive ausente
    switch (ah) {
      case 0x00: case 0x01: case 0x04: case 0x05: case 0x17: case 0x18:
        return done(0, ah === 0x04 ? al : undefined);                    // reset/status/verify/format/media: ok
      case 0x02: case 0x03: {
        const cyl = ((cx >> 8) & 0xFF) | ((cx & 0xC0) << 2), sec = cx & 0x3F, head = (dx >> 8) & 0xFF;
        if (al === 0 || sec < 1 || sec > SPT || head >= HEADS || cyl >= CYL) return done(0x04);   // setor não encontrado
        const lba = (cyl * HEADS + head) * SPT + (sec - 1);
        if (lba + al > CYL * HEADS * SPT) return done(0x04);
        const buf = new Uint8Array(al * 512), dst = ((c.sregs[0] << 4) + c.r16(3)) & 0xFFFFF;
        if (ah === 0x02) {
          this.disk.readSectors(lba, al, buf);
          for (let i = 0; i < buf.length; i++) m.write8((dst + i) & 0xFFFFF, buf[i]);
        } else {
          for (let i = 0; i < buf.length; i++) buf[i] = m.read8((dst + i) & 0xFFFFF);
          this.disk.writeSectors(lba, al, buf);
        }
        return done(0, al);
      }
      case 0x08:                                       // parâmetros do drive
        c.w16(3, 0x0004);                              // BL = tipo 4 (1,44 MB)
        c.w16(1, ((CYL - 1) << 8) | SPT);              // CH = cil máx, CL = setores/trilha
        c.w16(2, ((HEADS - 1) << 8) | 1);              // DH = cabeça máx, DL = nº de drives
        c.sregs[0] = 0; c.w16(7, 0);                   // ES:DI = 0 (sem tabela de parâmetros)
        return done(0);
      case 0x15: c.w8(4, 1); c.setF(1, 0); return;     // disquete sem change-line
      case 0x16: return done(0);                       // sem troca de mídia
      default: return done(0x01);                      // função inválida
    }
  }

  /** Sincroniza o PIT (levanta IRQ0 nas bordas de OUT0) e despacha IRQ pendente. */
  _syncDevices() {
    try { this.pit.sync(); } catch (e) { console.error('[PIT]', e.message); }
    try {
      if (this.cpu.getF(IF)) {
        const vec = this.pic.getPending();
        if (vec >= 0 && vec < 256) this._deliverIRQ(vec);
      }
    } catch (e) { console.error('[INT]', e.message); }
  }

  _loop = () => {
    if (!this.running) return;

    this._loopIterations++;

    try {
      const CYCLES_PER_FRAME = 500000;
      const CHUNK = 1000;                  // passos entre sincronizações de dispositivos
      let remaining = CYCLES_PER_FRAME;
      let failed = false;

      while (remaining > 0 && this.running && !failed) {
        const n = remaining < CHUNK ? remaining : CHUNK;
        remaining -= n;
        for (let i = 0; i < n; i++) {
          try {
            this.cpu.step();
            this.cycleCount++;
          } catch (e) {
            console.error('[CPU]', e.message);
            this.cpu.halted = true;
            this.crashed = true;                 // erro fatal: IRQs não retomam a CPU
            this._loopErrors++;
            const msg = `CPU: ${e.message}`.slice(0, 78);
            const line = 80 * 23;
            for (let j = 0; j < msg.length; j++) {
              this.mem.write8(0xB8000 + (line + j) * 2, msg.charCodeAt(j));
              this.mem.write8(0xB8000 + (line + j) * 2 + 1, 0x4F);
            }
            this.vga.markDirty();
            failed = true;
            break;
          }
        }
        this._syncDevices();
      }

      try { this.vga.tick(); } catch (e) { console.error('[VGA]', e.message); }

    } catch (e) {
      console.error('[LOOP FATAL]', e);
      this._loopErrors++;
      this.running = false;
    }

    if (this.running) {
      requestAnimationFrame(this._loop);
    }
  };

  loopStatus() {
    return {
      running: this.running,
      iterations: this._loopIterations,
      errors: this._loopErrors,
      cycles: this.cycleCount,
      ip: `0x${this.cpu.sregs[1].toString(16).padStart(4,'0')}:0x${this.cpu.ip.toString(16).padStart(4,'0')}`,
    };
  }
}