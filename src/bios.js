'use strict';

// ============================================================
// Handlers JS para INT 10h/11h/12h/13h/16h/19h/1Ah
// ============================================================
export function installBIOS(system) {
  const { cpu, mem, vga, kbd, disk } = system;
  const SCREEN = 0xB8000;

  function writeChar(ch, attr) {
    let cur = vga.cursorPos;
    if (ch === 0x0D) cur = Math.floor(cur / 80) * 80;
    else if (ch === 0x0A) cur = (Math.floor(cur / 80) + 1) * 80;
    else if (ch === 0x08) {
      if (cur > 0) {
        cur--;
        mem.write8(SCREEN + cur * 2, 0x20);
        mem.write8(SCREEN + cur * 2 + 1, attr);
      }
    } else {
      mem.write8(SCREEN + cur * 2, ch);
      mem.write8(SCREEN + cur * 2 + 1, attr);
      cur++;
    }
    if (cur >= 80 * 25) cur -= 80 * 25;
    vga.cursorPos = cur;
    vga.markDirty();
  }

  cpu.intHandler = function(vector) {
    const ax = this.r16(0), bx = this.r16(3), cx = this.r16(1),
          dx = this.r16(2), si = this.r16(6), di = this.r16(7),
          es = this.sregs[0];

    switch (vector) {
      case 0x10: {
        const ah = (ax >> 8) & 0xFF, al = ax & 0xFF;
        if (ah === 0x00) { vga.cursorPos = 0; vga.markDirty(); }
        else if (ah === 0x02) { vga.cursorPos = ((dx >> 8) & 0xFF) * 80 + (dx & 0xFF); vga.markDirty(); }
        else if (ah === 0x03) {
          this.w16(2, ((Math.floor(vga.cursorPos / 80) & 0xFF) << 8) | (vga.cursorPos % 80));
          this.w16(1, (vga.cursorPos % 80));
        }
        else if (ah === 0x05) { vga.cursorPos = 0; }
        else if (ah === 0x06) {
          const lines = al || 25;
          for (let i = 0; i < (25 - lines) * 80; i++) {
            mem.write8(SCREEN + i * 2, mem.read8(SCREEN + (i + lines * 80) * 2));
            mem.write8(SCREEN + i * 2 + 1, mem.read8(SCREEN + (i + lines * 80) * 2 + 1));
          }
          for (let i = (25 - lines) * 80; i < 25 * 80; i++) {
            mem.write8(SCREEN + i * 2, 0x20);
            mem.write8(SCREEN + i * 2 + 1, 0x07);
          }
          vga.markDirty();
        }
        else if (ah === 0x09 || ah === 0x0A) {
          const cnt = ah === 0x09 ? cx : 1;
          for (let i = 0; i < cnt; i++) writeChar(al, (bx & 0xFF) || 0x07);
        }
        else if (ah === 0x0E) { writeChar(al, 0x07); }
        else if (ah === 0x0F) { this.w16(0, (80 << 8) | (ax & 0xFF)); }
        else if (ah === 0x13) {
          const cnt = cx;
          const row = (dx >> 8) & 0xFF, col = dx & 0xFF;
          vga.cursorPos = row * 80 + col;
          for (let i = 0; i < cnt; i++) {
            const off = (es << 4) + ((si + i * (al === 3 ? 2 : 1)) & 0xFFFF);
            writeChar(mem.read8(off & 0xFFFFF), 0x07);
          }
        }
        break;
      }

      case 0x11: this.w16(0, (ax & 0xFF00) | 0x21); break;
      case 0x12: this.w16(0, (ax & 0xFF00) | 0x40); break;

      case 0x13: {
        const ah = (ax >> 8) & 0xFF;
        if (ah === 0x00) {
          this.w8(0, 0);
          this.setF(1, 0);
        } else if (ah === 0x02) {
          const al = ax & 0xFF;
          const cyl = (cx >> 8) | ((cx & 0xC0) << 2);
          const sec = cx & 0x3F;
          const head = (dx >> 8) & 0xFF;
          const lba = (cyl * 16 + head) * 63 + (sec - 1);
          const buf = new Uint8Array(al * 512);
          disk.readSectors(lba, al, buf);
          const dst = (es << 4) + bx;
          for (let i = 0; i < buf.length; i++) mem.write8((dst + i) & 0xFFFFF, buf[i]);
          this.w8(0, 0);
          this.setF(1, 0);
        } else if (ah === 0x08) {
          this.w16(1, 63 & 0x3F);
          this.w16(2, (15 << 8));
          this.w8(0, 0);
          this.setF(1, 0);
        } else {
          this.w8(0, 0x01);
          this.setF(1, 1);
        }
        break;
      }

      case 0x16: {
        const ah = (ax >> 8) & 0xFF;
        if (ah === 0x00) {
          if (kbd.buffer.length === 0) { this.ip -= 2; return; }
          const sc = kbd.buffer.shift();
          const ascii = kbd.ascii[sc] || 0;
          this.w16(0, (sc << 8) | ascii.charCodeAt(0));
        } else if (ah === 0x01) {
          if (kbd.buffer.length > 0) {
            const sc = kbd.buffer[0];
            const ascii = kbd.ascii[sc] || 0;
            this.w16(0, (sc << 8) | ascii.charCodeAt(0));
            this.setF(0x40, 0);
          } else {
            this.setF(0x40, 1);
          }
        }
        break;
      }

      case 0x19: {
        const buf = new Uint8Array(512);
        disk.readSectors(0, 1, buf);
        if (buf[510] === 0x55 && buf[511] === 0xAA) {
          for (let i = 0; i < 512; i++) mem.write8(0x7C00 + i, buf[i]);
          this.sregs[1] = 0;
          this.ip = 0x7C00;
          this.regs.fill(0);
          this.w16(2, 0x0080);
          this.w16(3, 0x7C00);
          this.flags = 0x2;
          this.halted = false;
        } else {
          this.halted = true;
        }
        break;
      }

      case 0x1A: {
        const ah = (ax >> 8) & 0xFF;
        if (ah === 0x00) {
          const ticks = Math.floor(Date.now() / (1000 / 18.2));
          this.w16(1, 0);
          this.w16(2, ticks & 0xFFFF);
        }
        break;
      }
    }
  };
}

// ============================================================
// BIOS ROM — stub mínimo em código de máquina x86 + carregador
// ============================================================

/**
 * Constrói uma ROM BIOS mínima de 64 KB em código de máquina real.
 *
 * Layout:
 *   0xF0000 + 0x0000  →  entrada do POST  (CLI; init; INT 19h; HLT)
 *   0xF0000 + 0xFFF0  →  vetor de reset   (JMP FAR F000:0000)
 */
export function buildMinimalBIOSRom() {
  const ROM_SIZE = 64 * 1024;
  const rom = new Uint8Array(ROM_SIZE);

  // --- POST code em offset 0x0000 ---
  let p = 0x0000;
  const emit = (...bytes) => { for (const b of bytes) rom[p++] = b; };

  emit(0xFA);             // CLI
  emit(0x31, 0xC0);       // XOR AX, AX
  emit(0x8E, 0xD8);       // MOV DS, AX
  emit(0x8E, 0xC0);       // MOV ES, AX
  emit(0x8E, 0xD0);       // MOV SS, AX
  emit(0xBC, 0x00, 0x7C); // MOV SP, 0x7C00
  emit(0xCD, 0x19);       // INT 19h → bootstrap
  emit(0xF4);             // HLT
  emit(0xEB, 0xFD);       // JMP $ (loop)

  // --- Vetor de reset em 0xFFF0 (física 0xFFFF0) ---
  rom[0xFFF0] = 0xEA;     // JMP FAR
  rom[0xFFF1] = 0x00;     // offset low
  rom[0xFFF2] = 0x00;     // offset high
  rom[0xFFF3] = 0x00;     // segment low
  rom[0xFFF4] = 0xF0;     // segment high

  return rom;
}

/**
 * Carrega uma ROM BIOS no espaço físico 0xE0000-0xFFFFF.
 * Alinhamento pelo topo — a última instrução DEVE estar em 0xFFFF0.
 */
export function loadBIOSInto(mem, binary) {
  const ROM_TOP = 0x100000;
  const start = ROM_TOP - binary.length;

  if (binary.length > 128 * 1024) {
    throw new Error(`BIOS muito grande: ${binary.length} bytes (máx 128 KB)`);
  }

  for (let i = 0; i < binary.length; i++) {
    mem.write8(start + i, binary[i]);
  }

  const b0 = mem.read8(0xFFFF0);
  if (b0 !== 0xEA && b0 !== 0xE9 && b0 !== 0xEB) {
    console.warn(
      `[BIOS] Aviso: vetor de reset em 0xFFFF0 = 0x${b0.toString(16)} ` +
      `(esperado 0xEA = JMP FAR). A ROM pode não inicializar corretamente.`
    );
  }
  console.log(`[BIOS] ROM carregada: ${binary.length} bytes em 0x${start.toString(16)}`);
}