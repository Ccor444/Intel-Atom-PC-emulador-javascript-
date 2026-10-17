'use strict';

// ============================================================
// VGA — Modo texto 80×25
// ============================================================
// Página de código 437 (a fonte do PC): o byte da memória de vídeo vira o caractere Unicode equivalente
// (molduras ┌─┐│└┘ ╔═╗║, sombras ░▒▓, setas, símbolos). Sem isso o canvas desenharia o byte como Latin-1.
const CP437 = Array.from(` ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_\`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ `);

export class VGA {
  constructor(mem, canvas) {
    this.mem = mem;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cursorPos = 0;
    this.cursorVisible = true;
    this.dirty = true;
    this.cursorIndex = 0;

    this.cellW = 8;
    this.cellH = 16;
    this.cols = 80;
    this.rows = 25;

    canvas.width = this.cols * this.cellW;
    canvas.height = this.rows * this.cellH;

    this.palette = [
      '#000000','#0000AA','#00AA00','#00AAAA',
      '#AA0000','#AA00AA','#AA5500','#AAAAAA',
      '#555555','#5555FF','#55FF55','#55FFFF',
      '#FF5555','#FF55FF','#FFFF55','#FFFFFF',
    ];
    this.render();
  }

  read(port) {
    switch (port) {
      case 0x3D4: return this.cursorIndex || 0;
      case 0x3D5: {
        const i = this.cursorIndex;
        if (i === 0x0E) return (this.cursorPos >> 8) & 0xFF;
        if (i === 0x0F) return this.cursorPos & 0xFF;
        return 0;
      }
      case 0x3DA: return this._status();
      default: return 0xFF;
    }
  }
  write(port, value) {
    switch (port) {
      case 0x3D4: this.cursorIndex = value & 0x3F; break;
      case 0x3D5: {
        const i = this.cursorIndex;
        if (i === 0x0E) this.cursorPos = (this.cursorPos & 0x00FF) | ((value & 0xFF) << 8);
        else if (i === 0x0F) this.cursorPos = (this.cursorPos & 0xFF00) | (value & 0xFF);
        else if (i === 0x0A) this.cursorVisible = (value & 0x20) === 0;
        this.markDirty();
        break;
      }
    }
  }

  /**
   * Registrador de status do CGA (0x3DA): modela 262 linhas por quadro a
   * 15 734 Hz (~59,9 Hz). bit0 = fora da área de display (retrace H ou V),
   * bit3 = pulso de sincronismo vertical (16 linhas, dentro do blanking vertical).
   * Sem isso, BIOS que esperam retrace antes de escrever no framebuffer ficam
   * girando para sempre. Usa o relógio virtual do PIT (this.clock).
   */
  _status() {
    const LINE_MS = 1000 / 15734.264, LINES = 262;
    const t = (this.clock ? this.clock.now() : performance.now()) / LINE_MS;
    const line = Math.floor(t) % LINES, frac = t - Math.floor(t);
    const vblank = line >= 200, hblank = frac >= 0.8;
    return (vblank || hblank ? 1 : 0) | (line >= 224 && line < 240 ? 8 : 0);
  }

  tick() {
    if (this.dirty) { this.render(); this.dirty = false; }
  }
  markDirty() { this.dirty = true; }

  render() {
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.font = '14px "Courier New", monospace';
    ctx.textBaseline = 'top';

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const off = 0xB8000 + (y * this.cols + x) * 2;
        const ch = this.mem.read8(off);
        const attr = this.mem.read8(off + 1);
        if (ch === 0 && attr === 0) continue;
        const fg = attr & 0x0F;
        const bg = (attr >> 4) & 0x0F;
        if (bg) {
          ctx.fillStyle = this.palette[bg];
          ctx.fillRect(x * this.cellW, y * this.cellH, this.cellW, this.cellH);
        }
        if (ch !== 0 && ch !== 0x20) {
          ctx.fillStyle = this.palette[fg];
          const px = x * this.cellW, py = y * this.cellH, w = this.cellW, h = this.cellH;
          // blocos e sombras: retângulos exatos (não dependem da fonte e fecham sem frestas entre células)
          if (ch === 0xDB) ctx.fillRect(px, py, w, h);
          else if (ch === 0xDC) ctx.fillRect(px, py + h / 2, w, h / 2);
          else if (ch === 0xDF) ctx.fillRect(px, py, w, h / 2);
          else if (ch === 0xDD) ctx.fillRect(px, py, w / 2, h);
          else if (ch === 0xDE) ctx.fillRect(px + w / 2, py, w / 2, h);
          else if (ch >= 0xB0 && ch <= 0xB2) { ctx.globalAlpha = 0.25 * (ch - 0xAF); ctx.fillRect(px, py, w, h); ctx.globalAlpha = 1; }
          else ctx.fillText(CP437[ch], px, py + 1);
        }
      }
    }
    if (this.cursorVisible) {
      const cx = (this.cursorPos % this.cols) * this.cellW;
      const cy = Math.floor(this.cursorPos / this.cols) * this.cellH;
      ctx.fillStyle = '#CCC';
      ctx.fillRect(cx, cy + this.cellH - 3, this.cellW, 2);
    }
  }
}

// ============================================================
// Keyboard PS/2
// ============================================================
export class Keyboard {
  constructor() {
    this.buffer = [];
    this.pic = null;
    this.xt = false; this.data = 0; this.queue = []; this.clockLow = false; this.pb7 = 0;
    this.map = {
      Escape:0x01, Digit1:0x02, Digit2:0x03, Digit3:0x04, Digit4:0x05,
      Digit5:0x06, Digit6:0x07, Digit7:0x08, Digit8:0x09, Digit9:0x0A,
      Digit0:0x0B, Minus:0x0C, Equal:0x0D, Backspace:0x0E, Tab:0x0F,
      KeyQ:0x10, KeyW:0x11, KeyE:0x12, KeyR:0x13, KeyT:0x14, KeyY:0x15,
      KeyU:0x16, KeyI:0x17, KeyO:0x18, KeyP:0x19, BracketLeft:0x1A,
      BracketRight:0x1B, Enter:0x1C, ControlLeft:0x1D, KeyA:0x1E, KeyS:0x1F,
      KeyD:0x20, KeyF:0x21, KeyG:0x22, KeyH:0x23, KeyJ:0x24, KeyK:0x25,
      KeyL:0x26, Semicolon:0x27, Quote:0x28, Backquote:0x29, ShiftLeft:0x2A,
      Backslash:0x2B, KeyZ:0x2C, KeyX:0x2D, KeyC:0x2E, KeyV:0x2F, KeyB:0x30,
      KeyN:0x31, KeyM:0x32, Comma:0x33, Period:0x34, Slash:0x35,
      ShiftRight:0x36, NumpadMultiply:0x37, AltLeft:0x38, Space:0x39,
      CapsLock:0x3A, F1:0x3B, F2:0x3C, F3:0x3D, F4:0x3E, F5:0x3F,
      F6:0x40, F7:0x41, F8:0x42, F9:0x43, F10:0x44, NumLock:0x45,
      ScrollLock:0x46, Home:0x47, ArrowUp:0x48, PageUp:0x49,
      ArrowLeft:0x4B, ArrowRight:0x4D, End:0x4F, ArrowDown:0x50,
      PageDown:0x51, Insert:0x52, Delete:0x53,
    };
    this.ascii = {
      0x02:'1',0x03:'2',0x04:'3',0x05:'4',0x06:'5',0x07:'6',0x08:'7',0x09:'8',0x0A:'9',0x0B:'0',
      0x0C:'-',0x0D:'=',0x0E:'\b',0x0F:'\t',
      0x10:'q',0x11:'w',0x12:'e',0x13:'r',0x14:'t',0x15:'y',0x16:'u',0x17:'i',0x18:'o',0x19:'p',
      0x1A:'[',0x1B:']',0x1C:'\n',
      0x1E:'a',0x1F:'s',0x20:'d',0x21:'f',0x22:'g',0x23:'h',0x24:'j',0x25:'k',0x26:'l',
      0x27:';',0x28:'\'',0x29:'`',0x2B:'\\',
      0x2C:'z',0x2D:'x',0x2E:'c',0x2F:'v',0x30:'b',0x31:'n',0x32:'m',
      0x33:',',0x34:'.',0x35:'/',0x39:' ',
    };
  }
  // ---- Modo XT (BIOS real): teclado serial ligado ao 8255 ------------------
  // Hardware do PC/XT: o teclado envia scancodes em série para um shift register
  // (74LS322). Quando o byte está completo, IRQ1 sobe e a porta A (0x60) mostra o
  // byte. O BIOS lê 0x60 e dá um pulso em PB7 da porta 0x61 (clear), que zera o
  // registrador e libera o próximo byte. Segurar PB6 (clock) em 0 e soltar reseta
  // o teclado, que responde 0xAA (self-test ok).
  resetXT() {
    this.xt = true; this.data = 0; this.queue = []; this.clockLow = false; this.pb7 = 0;
  }
  /** Chamado pelo PPI a cada escrita na porta B (0x61). */
  portB(oldV, newV) {
    if (!this.xt) return;
    const pb7 = (newV >> 7) & 1, clk = (newV >> 6) & 1;
    if (pb7 && !this.pb7) this.data = 0;                       // borda de subida de PB7: clear
    this.pb7 = pb7;
    if (!clk) this.clockLow = true;                            // PB6=0: teclado segurado
    else if (this.clockLow) {                                  // PB6 solto: reset + self-test
      this.clockLow = false;
      this.queue = [0xAA];
    }
    this._pump();
  }
  /** Entrega o próximo byte ao shift register quando ele está livre. */
  _pump() {
    if (this.data === 0 && this.queue.length && !this.clockLow) {
      this.data = this.queue.shift();
      if (this.pic) this.pic.raiseIRQ(1);
    }
  }
  /** Porta A (0x60) sem efeito colateral: devolve o byte do shift register. */
  readData() { return this.data; }

  keyDown(code) {
    const sc = this.map[code];
    if (sc === undefined) return false;
    if (this.xt) { this.queue.push(sc); this._pump(); return true; }
    this.buffer.push(sc);
    if (this.pic) this.pic.raiseIRQ(1);
    return true;
  }
  keyUp(code) {
    const sc = this.map[code];
    if (sc === undefined) return false;
    if (this.xt) { this.queue.push(sc | 0x80); this._pump(); }   // break code
    return true;
  }

  // Portas 0x60 (data) e 0x64 (status/command) — modo legado (ROM stub)
  read(port) {
    switch (port) {
      case 0x60: {
        if (this.xt) return this.data;
        if (this.buffer.length === 0) return 0;
        return this.buffer.shift();
      }
      case 0x64: {
        if (this.xt) return 0xFF;                              // XT não tem 0x64
        return this.buffer.length > 0 ? 0x01 : 0x00;
      }
      default: return 0xFF;
    }
  }
  write(port, value) {
    switch (port) {
      case 0x60: break;
      case 0x64: break;
    }
  }
}

// ============================================================
// IDE Disk
// ============================================================
export class IDEDisk {
  constructor(sizeMB = 4) {
    this.sizeBytes = sizeMB * 1024 * 1024;
    this.data = new Uint8Array(this.sizeBytes);
    this.model = 'ATOM-EMU-HDD';
  }
  readSectors(lba, count, buf) {
    const off = lba * 512;
    for (let i = 0; i < count * 512; i++) buf[i] = this.data[off + i] || 0;
  }
  writeSectors(lba, count, buf) {
    const off = lba * 512;
    for (let i = 0; i < count * 512; i++) this.data[off + i] = buf[i];
  }
}

// ============================================================
// Relógio virtual monotônico (base de tempo do PIT)
// ============================================================
// Intel 8254: o contador é clockado por CLK0..2 = 14,31818 MHz / 12
// = 1 193 181,818… Hz (cristal NTSC do PC/XT dividido por 12).
export const PIT_HZ = 105e6 / 88;
export const PIT_TICKS_PER_MS = PIT_HZ / 1000;

/**
 * Relógio em ms, estritamente não-decrescente, com resolução melhor que a de
 * performance.now().
 *
 * Por quê: navegadores arredondam performance.now() (Chrome ~100 µs, Firefox
 * ~1 ms, ou mais com resistFingerprinting). Em 100 µs passam ~119 ticks do
 * PIT, e uma CPU emulada executa milhares de instruções nesse intervalo, então
 * leituras em rajada veriam SEMPRE o mesmo valor ("contador congelado").
 *
 * Solução: dentro de um degrau do relógio real, o tempo é interpolado pelo
 * número de instruções emuladas desde o último degrau (taxa medida em
 * passos/ms). A interpolação é limitada a < 1 degrau, e a cada novo degrau o
 * relógio volta a ser exatamente o tempo real. Logo não há deriva acumulada
 * e nunca se adianta mais que um degrau do tempo real.
 */
export class MonotonicClock {
  /**
   * @param {object}   [o]
   * @param {Function} [o.real]  fonte de tempo em ms (padrão: performance.now)
   * @param {Function} [o.steps] contador de instruções executadas (opcional)
   * @param {number}   [o.maxQuantumMs] maior degrau considerado "resolução"
   */
  constructor({ real = () => performance.now(), steps = null, maxQuantumMs = 2 } = {}) {
    this._real = real;
    this._steps = steps;
    this._qMax = maxQuantumMs;
    this._lastReal = real();
    this._lastSteps = steps ? steps() : 0;
    this._out = this._lastReal;
    this._quantum = 0;     // degrau médio observado do relógio real (ms)
    this._rate = 0;        // instruções por ms (média móvel)
    this._samples = 0;
  }

  now() {
    const r = this._real();
    const s = this._steps ? this._steps() : 0;
    if (s < this._lastSteps) this._lastSteps = s;   // contador de instruções foi zerado (reset)

    if (r > this._lastReal) {
      const dt = r - this._lastReal;
      const ds = s - this._lastSteps;
      // Só aprende com degraus contíguos (descarta pausas entre frames).
      if (dt <= this._qMax) {
        this._quantum = this._samples === 0 ? dt : this._quantum * 0.9 + dt * 0.1;
        if (ds > 0) {
          const rate = ds / dt;
          this._rate = this._rate === 0 ? rate : this._rate * 0.9 + rate * 0.1;
        }
        this._samples++;
      }
      this._lastReal = r;
      this._lastSteps = s;
      if (r > this._out) this._out = r;
      return this._out;
    }

    // Mesmo degrau do relógio real: interpola por instruções executadas.
    if (this._steps && this._rate > 0 && this._samples >= 3) {
      let frac = (s - this._lastSteps) / this._rate;
      const cap = this._quantum * 0.95;
      if (frac > cap) frac = cap;
      const t = this._lastReal + frac;
      if (t > this._out) this._out = t;
    }
    return this._out;
  }
}

// ============================================================
// PIC 8259A — mestre (0x20/0x21) + escravo (0xA0/0xA1)
// ============================================================
const ctz = (x) => 31 - Math.clz32(x & -x);

export class PIC8259 {
  constructor() { this.reset(); }

  _mk(base) {
    return { irr: 0, isr: 0, imr: 0xFF, base, icw: 0, needIcw4: false,
             single: false, autoEoi: false, readIsr: false };
  }
  reset() {
    this.master = this._mk(0x08);
    this.slave  = this._mk(0x70);
  }

  /** Linha IRQ n (0-15) sobe (disparo por borda: fica latched em IRR). */
  raiseIRQ(n) {
    if (n < 8) this.master.irr |= (1 << n);
    else this.slave.irr |= (1 << (n - 8));
  }
  lowerIRQ(n) {
    if (n < 8) this.master.irr &= ~(1 << n);
    else this.slave.irr &= ~(1 << (n - 8));
  }

  // Resolve a interrupção de maior prioridade (prioridade fixa, 0 = maior).
  _next(ack) {
    const m = this.master, s = this.slave;
    const slaveReq = s.irr & ~s.imr;
    const cand = ((m.irr & ~4) | (slaveReq ? 4 : 0)) & ~m.imr;
    const mLim = m.isr ? ctz(m.isr) : 8;
    for (let i = 0; i < mLim; i++) {
      if (!(cand & (1 << i))) continue;
      if (i === 2) {                                  // cascata
        const sLim = s.isr ? ctz(s.isr) : 8;
        for (let j = 0; j < sLim; j++) {
          if (!(slaveReq & (1 << j))) continue;
          if (ack) {
            s.irr &= ~(1 << j); s.isr |= (1 << j);
            m.isr |= 4;
            if (s.autoEoi) s.isr &= ~(1 << j);
          }
          return s.base + j;
        }
        continue;
      }
      if (ack) {
        m.irr &= ~(1 << i); m.isr |= (1 << i);
        if (m.autoEoi) m.isr &= ~(1 << i);
      }
      return m.base + i;
    }
    return -1;
  }
  hasPending() { return this._next(false) >= 0; }
  /** INTA: devolve o vetor e move IRR→ISR; -1 se nada pendente. */
  getPending() { return this._next(true); }
  /** Compat: EOI não-específico no mestre. */
  eoi() { this.master.isr &= ~(this.master.isr & -this.master.isr); }

  write(port, v) {
    v &= 0xFF;
    const c = (port & 0xFE) === 0x20 ? this.master : this.slave;
    if ((port & 1) === 0) {
      if (v & 0x10) {                       // ICW1
        c.irr = 0; c.isr = 0; c.imr = 0; c.readIsr = false; c.autoEoi = false;
        c.needIcw4 = !!(v & 1); c.single = !!(v & 2); c.icw = 2;
      } else if (v & 0x08) {                // OCW3
        if (v & 2) c.readIsr = !!(v & 1);
      } else {                              // OCW2 (EOI)
        const cmd = v >> 5;
        if (cmd === 1 || cmd === 5) c.isr &= ~(c.isr & -c.isr);   // não-específico
        else if (cmd === 3 || cmd === 7) c.isr &= ~(1 << (v & 7)); // específico
      }
    } else if (c.icw === 2) {               // ICW2: base do vetor
      c.base = v & 0xF8;
      c.icw = c.single ? (c.needIcw4 ? 4 : 0) : 3;
    } else if (c.icw === 3) {               // ICW3 (cascata fixa em IRQ2)
      c.icw = c.needIcw4 ? 4 : 0;
    } else if (c.icw === 4) {               // ICW4
      c.autoEoi = !!(v & 2);
      c.icw = 0;
    } else {
      c.imr = v;                            // OCW1: máscara
    }
  }
  read(port) {
    const c = (port & 0xFE) === 0x20 ? this.master : this.slave;
    if (port & 1) return c.imr;
    return c.readIsr ? c.isr : c.irr;
  }
}

// ============================================================
// PIT 8254 — 3 contadores de 16 bits, modos 0-5, latch, read-back, BCD
// ============================================================
// Modelo: em vez de decrementar um registrador a cada tick (impossível e
// impreciso a 1,19 MHz num loop de rAF), cada canal guarda a ORIGEM da
// contagem (`start`, índice absoluto de tick do CLK que carregou a contagem)
// e o valor do contador é uma função pura de (tick_atual - start). Isso
// garante: leitura sempre refletindo o tempo real, nenhuma fração acumulada
// (zero deriva) e nenhuma dependência do número/intervalo das leituras.
//
// Referência: Intel 8254 Programmable Interval Timer datasheet (231244-004).
const bcd2int = (v) => ((v >> 12) & 15) * 1000 + ((v >> 8) & 15) * 100 + ((v >> 4) & 15) * 10 + (v & 15);
const int2bcd = (v) => (Math.floor(v / 1000) % 10 << 12) | (Math.floor(v / 100) % 10 << 8) |
                       (Math.floor(v / 10) % 10 << 4) | (v % 10);

export class PIT8254 {
  /**
   * @param {PIC8259} pic    recebe raiseIRQ(0) a cada borda de subida de OUT0
   * @param {MonotonicClock|{now:Function}} [clock] fonte de tempo (ms)
   */
  constructor(pic, clock) {
    this.pic = pic;
    this.clock = clock || new MonotonicClock();
    this.channels = [0, 1, 2].map(() => ({}));
    this.reset();
  }

  /** Estado de power-on. O canal 2 tem GATE vindo da porta 0x61 (inicia em 0). */
  reset() {
    this._t0 = this.clock.now();
    this.channels.forEach((ch, i) => Object.assign(ch, {
      mode: 0, rw: 0, bcd: 0,
      reload: 0,            // última contagem escrita (bruta)
      n: 65536,             // contagem efetiva em uso (0 => 65536 / 10000)
      nextN: null,          // contagem escrita, a aplicar na fronteira/trigger
      pendingAt: Infinity,  // tick em que nextN entra (modos 2/3)
      loaded: false, running: false, triggered: false,
      start: 0, frozen: null, edgesSeen: 0,
      gate: i === 2 ? 0 : 1,
      writeHigh: false, lowByte: 0, readHigh: false,
      latch: null, statusLatch: null,
    }));
  }

  // ---- tempo ------------------------------------------------------------
  /** Índice absoluto do tick de CLK corrente (sem estado acumulado). */
  _ticks() {
    return Math.floor((this.clock.now() - this._t0) * PIT_TICKS_PER_MS);
  }
  /** Ticks de contagem efetivos desde a carga (congelado se GATE baixo). */
  _elapsed(ch, tick) {
    if (!ch.running) return 0;
    if (ch.frozen !== null) return ch.frozen;
    const e = tick - ch.start;
    return e > 0 ? e : 0;
  }

  // ---- funções puras do modelo -------------------------------------------
  /** Nº de bordas de subida de OUT desde a origem atual (datasheet: Mode Definitions). */
  _edgeCount(ch, e) {
    const n = ch.n;
    switch (ch.mode) {
      case 0: return ch.loaded && e >= n ? 1 : 0;                 // OUT sobe em TC
      case 1: return ch.triggered && e >= n ? 1 : 0;
      case 2: case 3: return n >= 2 ? Math.floor(e / n) : 0;      // 1 por período
      case 4: return ch.loaded && e >= n + 1 ? 1 : 0;             // pulso de 1 CLK em TC
      case 5: return ch.triggered && e >= n + 1 ? 1 : 0;
    }
    return 0;
  }

  /** Nível de OUT (0/1). */
  _out(ch, tick) {
    if (!ch.loaded) return ch.mode === 0 ? 0 : 1;   // Mode 0: OUT baixo após control word
    const e = this._elapsed(ch, tick), n = ch.n;
    switch (ch.mode) {
      case 0: return e >= n ? 1 : 0;
      case 1: return (!ch.triggered || e >= n) ? 1 : 0;
      case 2: return (ch.gate === 0 || n < 2 || (e % n) !== n - 1) ? 1 : 0;
      case 3: return (ch.gate === 0 || n < 2 || (e % n) < Math.ceil(n / 2)) ? 1 : 0;
      case 4: return e === n ? 0 : 1;
      case 5: return (!ch.triggered || e !== n) ? 1 : 0;
    }
    return 1;
  }

  /** Valor visível do contador (16 bits, binário ou BCD). */
  _value(ch, tick) {
    if (!ch.loaded) return 0;
    const e = this._elapsed(ch, tick), n = ch.n;
    const mod = ch.bcd ? 10000 : 65536;
    let v;
    switch (ch.mode) {
      case 1: case 5:
        v = ch.triggered ? n - e : n; break;
      case 2:
        v = n < 2 ? n : n - (e % n); break;                       // N..1, recarrega
      case 3: {
        if (n < 2) { v = n; break; }
        const r = e % n;
        if ((n & 1) === 0) v = n - 2 * (r % (n / 2));             // decrementa de 2 em 2
        else {                                                    // N ímpar: -1, depois -2; fase baixa -3, -2…
          const hi = (n + 1) >> 1;
          if (r < hi) v = r === 0 ? n : n + 1 - 2 * r;
          else { const j = r - hi; v = j === 0 ? n : n - 1 - 2 * j; }
        }
        break;
      }
      default: v = n - e;                                         // modos 0 e 4: segue contando após TC (FFFF / 9999)
    }
    v = ((v % mod) + mod) % mod;
    return ch.bcd ? int2bcd(v) : v;
  }

  _isNull(ch, tick) {
    if (!ch.loaded) return true;
    if ((ch.mode === 1 || ch.mode === 5) && !ch.triggered) return true;
    return ch.running && tick < ch.start;
  }

  // ---- sincronização com o mundo (IRQ0, escrita pendente) ----------------
  /** Aplica contagem pendente (modos 2/3) na fronteira do período. */
  _prep(ch, tick) {
    if (ch.nextN !== null && ch.pendingAt <= tick && (ch.mode === 2 || ch.mode === 3)) {
      const b = ch.pendingAt;
      const edges = this._edgeCount(ch, b - ch.start);   // borda na própria fronteira
      if (edges > ch.edgesSeen && ch === this.channels[0] && this.pic) this.pic.raiseIRQ(0);
      ch.start = b; ch.n = ch.nextN; ch.nextN = null; ch.pendingAt = Infinity; ch.edgesSeen = 0;
    }
  }

  /**
   * Detecta bordas de subida de OUT0 e levanta IRQ0 no PIC (OUT0 → IRQ0 no PC).
   * Deve ser chamado com frequência (a Motherboard chama a cada ~1000 passos);
   * também é chamado em todo acesso de I/O.
   */
  sync() {
    const tick = this._ticks();
    const ch = this.channels[0];
    this._prep(ch, tick);
    const edges = this._edgeCount(ch, this._elapsed(ch, tick));
    if (edges > ch.edgesSeen) {
      ch.edgesSeen = edges;
      if (this.pic) this.pic.raiseIRQ(0);
    }
    this._prep(this.channels[1], tick);
    this._prep(this.channels[2], tick);
  }
  /** Compat com a API antiga (ignora o argumento: o tempo vem do relógio). */
  advance() { this.sync(); }

  // ---- GATE (datasheet: GATE Operation table) ----------------------------
  setGate(i, level) {
    const ch = this.channels[i];
    level = level ? 1 : 0;
    if (ch.gate === level) return;
    this.sync();
    const tick = this._ticks();
    this._prep(ch, tick);
    ch.gate = level;
    switch (ch.mode) {
      case 0: case 4:                                  // baixo: pausa; alto: retoma
        if (!ch.running) break;
        if (!level) ch.frozen = this._elapsed(ch, tick);
        else if (ch.frozen !== null) { ch.start = tick - ch.frozen; ch.frozen = null; }
        break;
      case 2: case 3:                                  // baixo: pausa + OUT=1; subida: recarrega
        if (!ch.loaded) break;
        if (!level) { if (ch.running && ch.frozen === null) ch.frozen = this._elapsed(ch, tick); }
        else {
          if (ch.nextN !== null) { ch.n = ch.nextN; ch.nextN = null; ch.pendingAt = Infinity; }
          ch.running = true; ch.start = tick + 1; ch.frozen = null; ch.edgesSeen = 0;
        }
        break;
      case 1: case 5:                                  // subida: dispara
        if (level && ch.loaded) {
          if (ch.nextN !== null) { ch.n = ch.nextN; ch.nextN = null; }
          ch.triggered = true; ch.running = true; ch.start = tick + 1;
          ch.frozen = null; ch.edgesSeen = 0;
        }
        break;
    }
  }
  getGate(i) { return this.channels[i].gate; }
  getOut(i) { return this._out(this.channels[i], this._ticks()); }

  /** Bit 4 da porta 0x61 (XT/AT): toggle de refresh de DRAM, ~15,085 µs (18 ticks). */
  refreshToggle() { return Math.floor(this._ticks() / 18) & 1; }

  // ---- barramento de I/O -------------------------------------------------
  /** Escrita nas portas 0x40-0x43 (A0,A1 selecionam; 0x44-0x5F espelham). */
  write(port, value) {
    value &= 0xFF;
    const reg = port & 3;
    if (reg === 3) this._writeControl(value);
    else this._writeData(reg, value);
    this.sync();
  }
  /** Leitura nas portas 0x40-0x42; a 0x43 é write-only (barramento flutuando). */
  read(port) {
    const reg = port & 3;
    const v = reg === 3 ? 0xFF : this._readData(reg);
    this.sync();
    return v;
  }

  /** Control Word (datasheet: Control Word Format / Read-Back Command). */
  _writeControl(v) {
    const tick = this._ticks();
    const sc = v >> 6;
    if (sc === 3) { this._readBack(v, tick); return; }
    const ch = this.channels[sc];
    const rw = (v >> 4) & 3;
    if (rw === 0) { this._latchCount(ch, tick); return; }       // Counter Latch Command
    let mode = (v >> 1) & 7;
    if (mode > 5) mode &= 3;                                    // 6→2, 7→3 (bit M2 "don't care")
    this.sync();
    Object.assign(ch, {
      rw, mode, bcd: v & 1,
      loaded: false, running: false, triggered: false, frozen: null,
      nextN: null, pendingAt: Infinity, edgesSeen: 0,
      writeHigh: false, readHigh: false, latch: null, statusLatch: null,
    });
  }

  /** Counter Latch: congela o valor; ignorado se já há latch pendente. */
  _latchCount(ch, tick) {
    if (ch.latch !== null) return;
    this._prep(ch, tick);
    const v = this._value(ch, tick);
    if (ch.rw === 1) ch.latch = [v & 0xFF];
    else if (ch.rw === 2) ch.latch = [v >> 8];
    else ch.latch = [v & 0xFF, v >> 8];
  }

  /** Read-Back (somente 8254): bit5 /COUNT, bit4 /STATUS, bits3-1 = canais 2,1,0. */
  _readBack(v, tick) {
    for (let i = 0; i < 3; i++) {
      if (!(v & (2 << i))) continue;
      const ch = this.channels[i];
      this._prep(ch, tick);
      if (!(v & 0x10) && ch.statusLatch === null) {
        ch.statusLatch = (this._out(ch, tick) << 7) | ((this._isNull(ch, tick) ? 1 : 0) << 6) |
                         (ch.rw << 4) | (ch.mode << 1) | ch.bcd;
      }
      if (!(v & 0x20)) this._latchCount(ch, tick);
    }
  }

  _readData(i) {
    const ch = this.channels[i];
    const tick = this._ticks();
    this._prep(ch, tick);
    if (ch.statusLatch !== null) { const s = ch.statusLatch; ch.statusLatch = null; return s; }
    if (ch.latch !== null) {
      const b = ch.latch.shift();
      if (ch.latch.length === 0) ch.latch = null;
      return b;
    }
    // Leitura "ao vivo" sem latch: cada byte amostra o contador naquele instante
    // (como no chip real; por isso o datasheet recomenda latch antes de ler).
    const v = this._value(ch, tick);
    if (ch.rw === 1) return v & 0xFF;
    if (ch.rw === 2) return v >> 8;
    if (!ch.readHigh) { ch.readHigh = true; return v & 0xFF; }
    ch.readHigh = false;
    return v >> 8;
  }

  _writeData(i, v) {
    const ch = this.channels[i];
    if (ch.rw === 0) return;                                    // sem control word: ignora
    const tick = this._ticks();
    this._prep(ch, tick);
    if (ch.rw === 1) this._commit(ch, v, tick);
    else if (ch.rw === 2) this._commit(ch, v << 8, tick);
    else if (!ch.writeHigh) {
      ch.lowByte = v; ch.writeHigh = true;
      if (ch.mode === 0) { ch.running = false; ch.loaded = false; }   // Mode 0: 1º byte para a contagem, OUT=0
    } else {
      ch.writeHigh = false;
      this._commit(ch, ch.lowByte | (v << 8), tick);
    }
  }

  /** Contagem completa escrita: aplica conforme o modo (datasheet: Mode Definitions). */
  _commit(ch, raw, tick) {
    ch.reload = raw;
    const n = ch.bcd ? (bcd2int(raw) || 10000) : (raw || 65536);   // 0 = contagem máxima
    switch (ch.mode) {
      case 0: case 4:      // carrega no próximo CLK e começa a contar
        ch.n = n; ch.nextN = null; ch.loaded = true; ch.running = true;
        ch.start = tick + 1; ch.frozen = ch.gate ? null : 0; ch.edgesSeen = 0;
        break;
      case 1: case 5:      // só vale no próximo trigger de GATE
        if (!ch.loaded) ch.n = n;
        ch.nextN = ch.loaded ? n : null; ch.loaded = true;
        break;
      case 2: case 3:
        if (!ch.loaded || !ch.running) {
          ch.n = n; ch.nextN = null; ch.loaded = true; ch.running = true;
          ch.start = tick + 1; ch.frozen = ch.gate ? null : 0; ch.edgesSeen = 0;
        } else {           // já contando: nova contagem entra no fim do período
          ch.nextN = n;
          if (ch.frozen !== null) ch.pendingAt = Infinity;      // GATE baixo: aplica na subida
          else {
            const e = this._elapsed(ch, tick);
            ch.pendingAt = ch.start + (Math.floor(e / ch.n) + 1) * ch.n;
          }
        }
        break;
    }
  }
}

// ============================================================
// DMA 8237A — 4 canais, portas 0x00-0x0F (+ registradores de página 0x80-0x8F)
// ============================================================
// Registradores (datasheet Intel 8237A): endereço/contagem de 16 bits por canal,
// acessados por um flip-flop de byte COMPARTILHADO (low, depois high); comando,
// modo, máscara, request, status e registrador temporário. Ainda não executa
// transferências (o disco é atendido por INT 13h em JS); o estado fica pronto
// para um FDC/IDE futuro usar via `ch[n].curAddr/curCount/mode`.
export class DMA8237 {
  constructor() { this.reset(); this.page = new Uint8Array(16); }

  /** Master Clear (escrita em 0x0D / RESET): zera comando, status, request, temp, flip-flop; máscaras = 1. */
  reset() {
    this.ch = [0, 1, 2, 3].map(() => ({ baseAddr: 0, curAddr: 0, baseCount: 0, curCount: 0, mode: 0 }));
    this.command = 0; this.status = 0; this.request = 0; this.temp = 0;
    this.mask = 0x0F; this.flip = 0;
  }

  _wr16(ch, key, v) {                      // 1º acesso = low, 2º = high
    const b = ch['base' + key], c = ch['cur' + key];
    if (!this.flip) { ch['base' + key] = (b & 0xFF00) | v; ch['cur' + key] = (c & 0xFF00) | v; }
    else            { ch['base' + key] = (b & 0x00FF) | (v << 8); ch['cur' + key] = (c & 0x00FF) | (v << 8); }
    this.flip ^= 1;
  }
  _rd16(ch, key) {
    const v = ch['cur' + key];
    const r = this.flip ? (v >> 8) & 0xFF : v & 0xFF;
    this.flip ^= 1;
    return r;
  }

  write(port, v) {
    v &= 0xFF;
    if (port >= 0x80 && port <= 0x8F) { this.page[port & 15] = v; return; }
    const r = port & 0x0F;
    if (r < 8) { this._wr16(this.ch[r >> 1], (r & 1) ? 'Count' : 'Addr', v); return; }
    switch (r) {
      case 0x8: this.command = v; break;
      case 0x9: if (v & 4) this.request |= 1 << (v & 3); else this.request &= ~(1 << (v & 3)); break;
      case 0xA: if (v & 4) this.mask |= 1 << (v & 3); else this.mask &= ~(1 << (v & 3)); break;
      case 0xB: this.ch[v & 3].mode = v; break;
      case 0xC: this.flip = 0; break;                                  // Clear Byte Pointer Flip-Flop
      case 0xD: this.reset(); break;                                   // Master Clear
      case 0xE: this.mask = 0; break;                                  // Clear Mask Register
      case 0xF: this.mask = v & 0x0F; break;                           // Write All Mask Bits
    }
  }
  read(port) {
    if (port >= 0x80 && port <= 0x8F) return this.page[port & 15];
    const r = port & 0x0F;
    if (r < 8) return this._rd16(this.ch[r >> 1], (r & 1) ? 'Count' : 'Addr');
    switch (r) {
      case 0x8: { const s = (this.status & 0x0F) | ((this.request & 0x0F) << 4); this.status &= 0xF0; return s; } // TC bits limpam na leitura
      case 0xD: return this.temp;
      default: return 0xFF;                                            // 0x9-0xC, 0xE, 0xF: write-only
    }
  }
}

// ============================================================
// PPI 8255A — PC/XT: porta A 0x60, B 0x61, C 0x62, controle 0x63
// ============================================================
// Mode 0, A=entrada, B=saída, C=entrada (palavra de controle 0x99 do BIOS).
//  Porta A (leitura): PB7=0 → scancode do teclado; PB7=1 → chave DIP SW1.
//  Porta B (latch):   b0 GATE2 do PIT, b1 speaker, b2/b3 seleção de nibble de SW2,
//                     b4 /parity enable, b5 /IOCHK enable, b6 clock do teclado, b7 clear/SW1.
//  Porta C (leitura): b0-3 nibble de SW2, b4 cassete, b5 OUT2 do PIT, b6 I/O CH CK,
//                     b7 paridade de RAM  (b6/b7 = 0: sem erro).
// SW1 (IBM 5160): b0 = 1 há disquete (0 = sem FDC: o disco vem do INT 13h em JS), b1 = 8087, b3-2 = RAM da placa-mãe,
//                 b5-4 = vídeo (01 CGA 40x25, 10 CGA 80x25, 11 MDA), b7-6 = nº de drives − 1.
export class PPI8255 {
  /** @param {{pit:PIT8254, kbd:Keyboard, sw1?:number, sw2?:number, onSpeaker?:Function}} o */
  constructor({ pit, kbd, sw1 = 0x2C, sw2 = 18, onSpeaker = null }) {
    // sw2 = blocos de 32 KB de RAM de expansão (5 bits, 0-31). A GLaBIOS calcula
    //   KB = ((SW1 & 0x0C) + 4) * 4 + sw2 * 32   →   0x2C e 18: 64 + 576 = 640 KB.
    this.pit = pit; this.kbd = kbd; this.sw1 = sw1; this.sw2 = sw2 & 0x1F; this.onSpeaker = onSpeaker;
    this.reset();
  }
  reset() { this.portB = 0; this.ctrl = 0x99; }

  read(port) {
    switch (port & 3) {
      case 0: return (this.portB & 0x80) ? this.sw1 : this.kbd.readData();
      case 1: return this.portB;                                   // leitura do latch de saída
      case 2: {
        // PB2=1: chaves SW2 1-4 em PC0-3; PB2=0: chave SW2 5 em PC0 (esquema do IBM 5160)
        const sw = (this.portB & 0x04) ? (this.sw2 & 0x0F) : ((this.sw2 >> 4) & 1);
        return sw | (this.pit.getOut(2) << 5);                     // b6/b7 = 0: sem erro de paridade/IOCHK
      }
      default: return 0xFF;                                        // 0x63 é write-only
    }
  }
  write(port, v) {
    v &= 0xFF;
    switch (port & 3) {
      case 1: {
        const old = this.portB;
        this.portB = v;
        this.pit.setGate(2, v & 1);
        this.kbd.portB(old, v);
        if (this.onSpeaker && ((old ^ v) & 3)) this.onSpeaker(!!(v & 1) && !!(v & 2), v);
        break;
      }
      case 3:
        if (v & 0x80) { this.ctrl = v; this.portB = 0; this.pit.setGate(2, 0); }   // mode set: zera latches
        break;                                                                    // BSR em C: C é entrada, ignorado
    }
  }
}

// ============================================================
// UART 16550A — COM1 (0x3F8-0x3FF)
// ============================================================
// A GLaBIOS detecta a porta lendo o IIR (base+2) e exigindo o nibble alto zero (FIFO desligado).
// Modelo: registradores completos (DLAB, divisor, LCR, MCR, LSR, MSR, SCR), loopback do MCR e fila de
// recepção; sem IRQ (IER é guardado, mas nada é disparado).
export class UART16550 {
  constructor() {
    this.onTx = null;            // (byte) => void — recebe o que o programa envia
    this.txLog = '';             // histórico de texto enviado (limitado)
    this.reset();
  }
  reset() {
    this.ier = 0; this.fcr = 0; this.lcr = 0; this.mcr = 0; this.scr = 0; this.dll = 1; this.dlm = 0;
    this.rx = [];
  }
  /** Injeta um byte na recepção (ex.: teclado de um terminal serial no navegador). */
  receive(b) { if (this.rx.length < 16) this.rx.push(b & 0xFF); }
  _msr() {
    if (this.mcr & 0x10)         // loopback: MCR → MSR (RTS→CTS, DTR→DSR, OUT1→RI, OUT2→DCD)
      return ((this.mcr & 2) << 3) | ((this.mcr & 1) << 5) | ((this.mcr & 4) << 4) | ((this.mcr & 8) << 4);
    return 0x30;                 // CTS e DSR ativos: o INT 14h só envia se o "modem" estiver pronto
  }
  write(port, v) {
    v &= 0xFF; const dlab = this.lcr & 0x80;
    switch (port & 7) {
      case 0:
        if (dlab) this.dll = v;
        else if (this.mcr & 0x10) this.receive(v);                       // loopback
        else { this.txLog = (this.txLog + String.fromCharCode(v)).slice(-65536); if (this.onTx) this.onTx(v); }
        break;
      case 1: if (dlab) this.dlm = v; else this.ier = v & 0x0F; break;
      case 2: this.fcr = v & 0xC9; if (v & 2) this.rx.length = 0; break;
      case 3: this.lcr = v; break;
      case 4: this.mcr = v & 0x1F; break;
      case 7: this.scr = v; break;
    }
  }
  read(port) {
    const dlab = this.lcr & 0x80;
    switch (port & 7) {
      case 0: return dlab ? this.dll : (this.rx.length ? this.rx.shift() : 0);
      case 1: return dlab ? this.dlm : this.ier;
      case 2: return 0x01 | ((this.fcr & 1) ? 0xC0 : 0);                  // sem interrupção pendente
      case 3: return this.lcr;
      case 4: return this.mcr;
      case 5: return 0x60 | (this.rx.length ? 1 : 0);                      // THRE + TEMT (+ dado pronto)
      case 6: return this._msr();
      default: return this.scr;
    }
  }
}

// ============================================================
// Porta paralela (SPP) — LPT1 (0x378-0x37A), impressora virtual
// ============================================================
// A GLaBIOS escreve 0x0B na porta de dados e confere a releitura. O INT 17h envia o byte e dá o pulso de
// STROBE (controle bit0); a borda de descida "imprime".
export class ParallelPort {
  constructor() { this.onPrint = null; this.printed = ''; this.reset(); }
  reset() { this.data = 0; this.ctrl = 0x0C; }
  write(port, v) {
    v &= 0xFF;
    switch (port & 3) {
      case 0: this.data = v; break;
      case 2: {
        const fall = (this.ctrl & 1) && !(v & 1);
        this.ctrl = v & 0x3F;
        if (fall) { this.printed = (this.printed + String.fromCharCode(this.data)).slice(-65536); if (this.onPrint) this.onPrint(this.data); }
        break;
      }
    }
  }
  read(port) {
    switch (port & 3) {
      case 0: return this.data;
      case 1: return 0xDF;                       // não ocupada, sem erro, selecionada, sem fim de papel
      case 2: return (this.ctrl & 0x3F) | 0xC0;
      default: return 0xFF;
    }
  }
}
