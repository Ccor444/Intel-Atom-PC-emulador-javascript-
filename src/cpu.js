'use strict';

// EFLAGS bits
export const CF=1, PF=4, AF=16, ZF=64, SF=128, TF=256, IF=512, DF=1024, OF=2048;
export const ES=0, CS=1, SS=2, DS=3, FS=4, GS=5;

const PF_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i, c = 0;
  while (v) { c ^= 1; v &= v - 1; }
  PF_TABLE[i] = c ? 0 : 4;
}

export class CPU {
  constructor(mem) {
    this.mem = mem;
    this.regs = new Uint32Array(8);
    this.sregs = new Uint16Array(6);
    this.ip = 0;
    this.flags = 0x2;
    this.halted = false;
    this.a20 = false;            // linha A20: desligada = endereços dão a volta em 1 MB (FFFF:0010 → 0000:0000)

    this.osize = 16;
    this.asize = 16;
    this.segOvr = -1;
    this.rep = 0;

    this.ioRead  = () => 0xFF;
    this.ioWrite = () => {};
    this.intHandler = null;

    this.ops = new Array(256);
    this._initOps();
  }

  // ---- Register access ----
  r32(i) { return this.regs[i]; }
  w32(i, v) { this.regs[i] = v >>> 0; }
  r16(i) { return this.regs[i] & 0xFFFF; }
  w16(i, v) { this.regs[i] = (this.regs[i] & 0xFFFF0000) | (v & 0xFFFF); }
  r8(i)  { return i < 4 ? (this.regs[i] & 0xFF) : ((this.regs[i-4] >>> 8) & 0xFF); }
  w8(i, v) {
    if (i < 4) this.regs[i] = (this.regs[i] & 0xFFFFFF00) | (v & 0xFF);
    else       this.regs[i-4] = (this.regs[i-4] & 0xFFFF00FF) | ((v & 0xFF) << 8);
  }

  // ---- Flags ----
  getF(bit) { return (this.flags & bit) ? 1 : 0; }
  setF(bit, v) { if (v) this.flags |= bit; else this.flags &= ~bit; }

  // ---- Memory ----
  lin(seg, off) { return ((this.sregs[seg] << 4) + (off & 0xFFFF)) & (this.a20 ? 0x1FFFFF : 0xFFFFF); }
  rd8(seg, off)  { return this.mem.read8(this.lin(seg, off)); }
  rd16(seg, off) { return this.mem.read16(this.lin(seg, off)); }
  rd32(seg, off) { return this.mem.read32(this.lin(seg, off)); }
  wr8(seg, off, v)  { this.mem.write8(this.lin(seg, off), v); }
  wr16(seg, off, v) { this.mem.write16(this.lin(seg, off), v); }
  wr32(seg, off, v) { this.mem.write32(this.lin(seg, off), v); }

  // ---- Stack ----
  push(v) {
    if (this.osize === 16) {
      const sp = (this.r16(4) - 2) & 0xFFFF;
      this.w16(4, sp);
      this.wr16(SS, sp, v);
    } else {
      const sp = (this.r32(4) - 4) >>> 0;
      this.w32(4, sp);
      this.wr32(SS, sp & 0xFFFF, v);
    }
  }
  pop() {
    if (this.osize === 16) {
      const sp = this.r16(4);
      const v = this.rd16(SS, sp);
      this.w16(4, (sp + 2) & 0xFFFF);
      return v;
    } else {
      const sp = this.r32(4);
      const v = this.rd32(SS, sp & 0xFFFF);
      this.w32(4, (sp + 4) >>> 0);
      return v;
    }
  }

  // ---- Fetch ----
  f8()  { const v = this.mem.read8 (this.lin(CS, this.ip)); this.ip = (this.ip + 1) & 0xFFFF; return v; }
  f16() { const v = this.mem.read16(this.lin(CS, this.ip)); this.ip = (this.ip + 2) & 0xFFFF; return v; }
  f32() { const v = this.mem.read32(this.lin(CS, this.ip)); this.ip = (this.ip + 4) & 0xFFFF; return v; }

  // ---- ModRM ----
  modrm() {
    const b = this.f8();
    const mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
    if (mod === 3) return { reg, rm, mod, isReg: true, seg: 3, addr: 0 };

    let addr, seg = 3;
    if (this.asize === 16) {
      switch (rm) {
        case 0: addr = this.r16(3) + this.r16(6); break;
        case 1: addr = this.r16(3) + this.r16(7); break;
        case 2: addr = this.r16(5) + this.r16(6); seg = 2; break;
        case 3: addr = this.r16(5) + this.r16(7); seg = 2; break;
        case 4: addr = this.r16(6); break;
        case 5: addr = this.r16(7); break;
        case 6: if (mod === 0) { addr = this.f16(); } else { addr = this.r16(5); seg = 2; } break;
        case 7: addr = this.r16(3); break;
      }
      if (mod === 1) { const d = this.f8(); addr += (d & 0x80) ? d - 256 : d; }
      else if (mod === 2) addr += this.f16();
      addr &= 0xFFFF;
    } else {
      if (rm === 4) {
        const sib = this.f8();
        const ss = 1 << (sib >> 6), idx = (sib >> 3) & 7, bse = sib & 7;
        addr = (bse === 5 && mod === 0) ? this.f32() : this.r32(bse);
        if (idx !== 4) addr += this.r32(idx) * ss;
      } else if (rm === 5 && mod === 0) {
        addr = this.f32();
      } else {
        addr = this.r32(rm);
      }
      if (mod === 1) { const d = this.f8(); addr += (d & 0x80) ? d - 256 : d; }
      else if (mod === 2) addr += this.f32();
      addr >>>= 0;
    }
    if (this.segOvr >= 0) seg = this.segOvr;
    return { reg, rm, mod, isReg: false, seg, addr };
  }

  rdOp(rm, sz) {
    if (rm.isReg) return this.rdReg(rm.rm, sz);
    return sz === 8  ? this.rd8 (rm.seg, rm.addr) :
           sz === 16 ? this.rd16(rm.seg, rm.addr) :
                       this.rd32(rm.seg, rm.addr);
  }
  wrOp(rm, sz, v) {
    if (rm.isReg) return this.wrReg(rm.rm, sz, v);
    if (sz === 8) this.wr8(rm.seg, rm.addr, v);
    else if (sz === 16) this.wr16(rm.seg, rm.addr, v);
    else this.wr32(rm.seg, rm.addr, v);
  }
  rdReg(r, sz) {
    if (sz === 8) return this.r8(r);
    if (sz === 16) return this.r16(r);
    return this.r32(r);
  }
  wrReg(r, sz, v) {
    if (sz === 8) this.w8(r, v);
    else if (sz === 16) this.w16(r, v);
    else this.w32(r, v);
  }

  // ---- ALU ----
  alu(op, a, b, sz) {
    const mask = sz === 8 ? 0xFF : sz === 16 ? 0xFFFF : 0xFFFFFFFF;
    const sign = sz === 8 ? 0x80 : sz === 16 ? 0x8000 : 0x80000000;
    let r, cf = 0, of = 0;
    const c = this.getF(CF);
    // 32 bits: `&` do JS devolve INTEIRO COM SINAL; usa >>> 0 para que somas/comparações fiquem sem sinal
    a = (a & mask) >>> 0; b = (b & mask) >>> 0;
    switch (op) {
      case 0: r = a + b; cf = r > mask ? 1 : 0; of = ((a^r)&(b^r)&sign)?1:0; break;
      case 1: r = a | b; break;
      case 2: r = a + b + c; cf = r > mask ? 1 : 0; of = ((a^r)&(b^r)&sign)?1:0; break;
      case 3: r = a - b - c; cf = r < 0 ? 1 : 0; of = ((a^b)&(a^r)&sign)?1:0; break;
      case 4: r = a & b; break;
      case 5: r = a - b; cf = r < 0 ? 1 : 0; of = ((a^b)&(a^r)&sign)?1:0; break;
      case 6: r = a ^ b; break;
      case 7: r = a - b; cf = r < 0 ? 1 : 0; of = ((a^b)&(a^r)&sign)?1:0; break;
    }
    r = (r & mask) >>> 0;
    let f = this.flags & ~(CF|PF|AF|ZF|SF|OF);
    if (cf) f |= CF;
    f |= PF_TABLE[r & 0xFF];
    if ((a^b^r) & 0x10) f |= AF;
    if (r === 0) f |= ZF;
    if (r & sign) f |= SF;
    if (of) f |= OF;
    this.flags = f;
    return r;
  }

  // ---- Step ----
  step() {
    if (this.halted) return false;
    this._insStart = this.ip;                      // IP da instrução (exceções #UD empilham este endereço)

    this.osize = 16; this.asize = 16; this.segOvr = -1; this.rep = 0;
    let op;
    for (;;) {
      op = this.f8();
      if (op === 0x66) this.osize = 32;
      else if (op === 0x67) this.asize = 32;
      else if (op === 0x26) this.segOvr = ES;
      else if (op === 0x2E) this.segOvr = CS;
      else if (op === 0x36) this.segOvr = SS;
      else if (op === 0x3E) this.segOvr = DS;
      else if (op === 0x64) this.segOvr = FS;
      else if (op === 0x65) this.segOvr = GS;
      else if (op === 0xF0) {}
      else if (op === 0xF2) this.rep = 2;
      else if (op === 0xF3) this.rep = 3;
      else break;
    }

    const fn = this.ops[op];
    if (!fn) { this._ud(); return true; }          // opcode inválido: #UD (INT 6) como no hardware
    fn.call(this);
    return true;
  }

  _initOps() {
    const O = this.ops;
    const SZB = () => this.osize;

    const conds = [
      () => this.getF(OF), () => !this.getF(OF),
      () => this.getF(CF), () => !this.getF(CF),
      () => this.getF(ZF), () => !this.getF(ZF),
      () => this.getF(CF) || this.getF(ZF), () => !this.getF(CF) && !this.getF(ZF),
      () => this.getF(SF), () => !this.getF(SF),
      () => this.getF(PF), () => !this.getF(PF),
      () => this.getF(SF) !== this.getF(OF), () => this.getF(SF) === this.getF(OF),
      () => this.getF(ZF) || this.getF(SF) !== this.getF(OF),
      () => !this.getF(ZF) && this.getF(SF) === this.getF(OF),
    ];

    // ============================================================
    // Controle básico
    // ============================================================
    O[0x90] = () => {}; // NOP
    O[0xF4] = function() { this.halted = true; };
    O[0xFA] = function() { this.setF(IF, 0); };
    O[0xFB] = function() { this.setF(IF, 1); };
    O[0xFC] = function() { this.setF(DF, 0); };
    O[0xFD] = function() { this.setF(DF, 1); };
    O[0xF8] = function() { this.setF(CF, 0); };
    O[0xF9] = function() { this.setF(CF, 1); };
    O[0xF5] = function() { this.setF(CF, 1 - this.getF(CF)); };
    O[0x9C] = function() { this.push(this.flags); };
    O[0x9D] = function() { this.flags = (this.pop() | 0x2) & 0x3F7FD5; };

    // ---- LAHF / SAHF ----
    O[0x9E] = function() { // SAHF — Store AH into Flags
      const ah = this.r8(4);
      const mask = 0xD5; // CF PF AF ZF SF
      this.flags = (this.flags & ~mask) | (ah & mask);
    };
    O[0x9F] = function() { // LAHF — Load Flags into AH
      const f = this.flags;
      let ah = 0x02; // bit 1 sempre 1
      if (f & CF) ah |= 0x01;
      if (f & PF) ah |= 0x04;
      if (f & AF) ah |= 0x10;
      if (f & ZF) ah |= 0x40;
      if (f & SF) ah |= 0x80;
      this.w8(4, ah);
    };

    O[0x60] = function() { // PUSHA
      const sp = this.r16(4);
      this.push(this.r16(0)); this.push(this.r16(1));
      this.push(this.r16(2)); this.push(this.r16(3));
      this.push(sp); this.push(this.r16(5));
      this.push(this.r16(6)); this.push(this.r16(7));
    };
    O[0x61] = function() { // POPA
      this.w16(7, this.pop()); this.w16(6, this.pop());
      this.w16(5, this.pop()); this.pop();
      this.w16(3, this.pop()); this.w16(2, this.pop());
      this.w16(1, this.pop()); this.w16(0, this.pop());
    };

    O[0x62] = function() { // BOUND — no-op (não validamos limites)
      const rm = this.modrm();
      this.rdReg(rm.reg, SZB());
    };

    O[0x98] = function() { // CBW / CWDE
      if (this.osize === 16) {
        const al = this.r8(0);
        this.w16(0, (al & 0x80) ? (al | 0xFF00) : al);
      } else {
        const ax = this.r16(0);
        this.w32(0, (ax & 0x8000) ? ((ax | 0xFFFF0000) >>> 0) : ax);
      }
    };
    O[0x99] = function() { // CWD / CDQ
      if (this.osize === 16) {
        const ax = this.r16(0);
        this.w16(2, (ax & 0x8000) ? 0xFFFF : 0x0000);
      } else {
        const eax = this.r32(0);
        this.w32(2, (eax & 0x80000000) ? 0xFFFFFFFF : 0x00000000);
      }
    };

    // ---- MOV imm ----
    for (let i = 0; i < 8; i++) {
      const r = i;
      O[0xB0 + r] = function() { this.w8(r, this.f8()); };
      O[0xB8 + r] = function() {
        const v = (this.osize === 16) ? this.f16() : this.f32();
        this.wrReg(r, SZB(), v);
      };
    }

    // ---- MOV sreg ----
    O[0x8E] = function() {
      const rm = this.modrm();
      const idx = rm.reg;
      if (idx >= 6) throw new Error(`MOV sreg: índice inválido ${idx}`);
      this.sregs[idx] = this.rdOp(rm, 16) & 0xFFFF;
    };
    O[0x8C] = function() {
      const rm = this.modrm();
      const idx = rm.reg;
      if (idx >= 6) throw new Error(`MOV sreg: índice inválido ${idx}`);
      this.wrOp(rm, 16, this.sregs[idx]);
    };

    // ---- MOV r/m <-> r ----
    O[0x88] = function() { const rm = this.modrm(); this.wrOp(rm, 8, this.r8(rm.reg)); };
    O[0x89] = function() { const rm = this.modrm(); this.wrOp(rm, SZB(), this.rdReg(rm.reg, SZB())); };
    O[0x8A] = function() { const rm = this.modrm(); this.w8(rm.reg, this.rdOp(rm, 8)); };
    O[0x8B] = function() { const rm = this.modrm(); this.wrReg(rm.reg, SZB(), this.rdOp(rm, SZB())); };

    // ---- MOV r/m, imm ----
    O[0xC6] = function() { const rm = this.modrm(); this.wrOp(rm, 8, this.f8()); };
    O[0xC7] = function() {
      const rm = this.modrm();
      const v = (this.osize === 16) ? this.f16() : this.f32();
      this.wrOp(rm, SZB(), v);
    };

    // ---- MOV AL/AX/EAX <-> moffs ----
    O[0xA0] = function() { const a = this.asize === 16 ? this.f16() : this.f32(); this.w8(0, this.rd8(this.segOvr>=0?this.segOvr:3, a)); };
    O[0xA1] = function() { const a = this.asize === 16 ? this.f16() : this.f32(); this.wrReg(0, SZB(), this.rdOp({isReg:false,seg:this.segOvr>=0?this.segOvr:3,addr:a}, SZB())); };
    O[0xA2] = function() { const a = this.asize === 16 ? this.f16() : this.f32(); this.wr8(this.segOvr>=0?this.segOvr:3, a, this.r8(0)); };
    O[0xA3] = function() { const a = this.asize === 16 ? this.f16() : this.f32(); this.wrOp({isReg:false,seg:this.segOvr>=0?this.segOvr:3,addr:a}, SZB(), this.rdReg(0, SZB())); };

    // ---- LEA ----
    O[0x8D] = function() { const rm = this.modrm(); this.wrReg(rm.reg, SZB(), rm.addr); };

    // ---- LES / LDS ----
    O[0xC4] = function() { // LES r, m16:16/32
      const rm = this.modrm();
      const sz = SZB();
      if (sz === 16) {
        const lo = this.rd16(rm.seg, rm.addr);
        const hi = this.rd16(rm.seg, (rm.addr + 2) & 0xFFFF);
        this.wrReg(rm.reg, 16, lo);
        this.sregs[ES] = hi;
      } else {
        const lo = this.rd32(rm.seg, rm.addr);
        const hi = this.rd16(rm.seg, (rm.addr + 4) & 0xFFFF);
        this.wrReg(rm.reg, 32, lo);
        this.sregs[ES] = hi;
      }
    };
    O[0xC5] = function() { // LDS r, m16:16/32
      const rm = this.modrm();
      const sz = SZB();
      if (sz === 16) {
        const lo = this.rd16(rm.seg, rm.addr);
        const hi = this.rd16(rm.seg, (rm.addr + 2) & 0xFFFF);
        this.wrReg(rm.reg, 16, lo);
        this.sregs[DS] = hi;
      } else {
        const lo = this.rd32(rm.seg, rm.addr);
        const hi = this.rd16(rm.seg, (rm.addr + 4) & 0xFFFF);
        this.wrReg(rm.reg, 32, lo);
        this.sregs[DS] = hi;
      }
    };

    // ---- XCHG r/m, r ----
    O[0x86] = function() {
      const rm = this.modrm();
      const a = this.rdOp(rm, 8), b = this.r8(rm.reg);
      this.wrOp(rm, 8, b); this.w8(rm.reg, a);
    };
    O[0x87] = function() {
      const rm = this.modrm();
      const sz = SZB();
      const a = this.rdOp(rm, sz), b = this.rdReg(rm.reg, sz);
      this.wrOp(rm, sz, b); this.wrReg(rm.reg, sz, a);
    };
    // 0x91-0x97 XCHG AX, r
    for (let i = 1; i <= 7; i++) {
      const r = i;
      O[0x90 + i] = function() {
        const sz = SZB();
        const a = this.rdReg(0, sz);
        const b = this.rdReg(r, sz);
        this.wrReg(0, sz, b);
        this.wrReg(r, sz, a);
      };
    }

    // ---- ALU family ----
    const aluOpcodes = [
      [0x00, 8, 0], [0x01, 0, 0], [0x02, 8, 1], [0x03, 0, 1], [0x04, 8, 2], [0x05, 0, 2],
      [0x08, 8, 0], [0x09, 0, 0], [0x0A, 8, 1], [0x0B, 0, 1], [0x0C, 8, 2], [0x0D, 0, 2],
      [0x10, 8, 0], [0x11, 0, 0], [0x12, 8, 1], [0x13, 0, 1], [0x14, 8, 2], [0x15, 0, 2],
      [0x18, 8, 0], [0x19, 0, 0], [0x1A, 8, 1], [0x1B, 0, 1], [0x1C, 8, 2], [0x1D, 0, 2],
      [0x20, 8, 0], [0x21, 0, 0], [0x22, 8, 1], [0x23, 0, 1], [0x24, 8, 2], [0x25, 0, 2],
      [0x28, 8, 0], [0x29, 0, 0], [0x2A, 8, 1], [0x2B, 0, 1], [0x2C, 8, 2], [0x2D, 0, 2],
      [0x30, 8, 0], [0x31, 0, 0], [0x32, 8, 1], [0x33, 0, 1], [0x34, 8, 2], [0x35, 0, 2],
      [0x38, 8, 0], [0x39, 0, 0], [0x3A, 8, 1], [0x3B, 0, 1], [0x3C, 8, 2], [0x3D, 0, 2],
    ];
    for (const [opc, fixedSz, form] of aluOpcodes) {
      const op = Math.floor(opc / 8);
      O[opc] = function() {
        const sz = fixedSz ? 8 : SZB();
        if (form === 0) {
          const rm = this.modrm();
          const a = this.rdOp(rm, sz), b = this.rdReg(rm.reg, sz);
          const r = this.alu(op, a, b, sz);
          if (op !== 7) this.wrOp(rm, sz, r);
        } else if (form === 1) {
          const rm = this.modrm();
          const a = this.rdReg(rm.reg, sz), b = this.rdOp(rm, sz);
          const r = this.alu(op, a, b, sz);
          if (op !== 7) this.wrReg(rm.reg, sz, r);
        } else {
          const a = this.rdReg(0, sz);
          const b = sz === 8 ? this.f8() : sz === 16 ? this.f16() : this.f32();
          const r = this.alu(op, a, b, sz);
          if (op !== 7) this.wrReg(0, sz, r);
        }
      };
    }

    // ---- Group 1 ----
    // ESC (coprocessador matemático): sem 8087/FPU no PC, as instruções são ignoradas (só consomem o ModRM)
    for (let op = 0xD8; op <= 0xDF; op++) O[op] = function() { this.modrm(); };
    O[0x80] = function() {
      const rm = this.modrm();
      const op = rm.reg;
      const a = this.rdOp(rm, 8);
      const b = this.f8();
      const r = this.alu(op, a, b, 8);
      if (op !== 7) this.wrOp(rm, 8, r);
    };
    O[0x81] = function() {
      const sz = SZB();
      const rm = this.modrm();
      const op = rm.reg;
      const a = this.rdOp(rm, sz);
      const b = sz === 16 ? this.f16() : this.f32();
      const r = this.alu(op, a, b, sz);
      if (op !== 7) this.wrOp(rm, sz, r);
    };
    O[0x83] = function() {
      const sz = SZB();
      const rm = this.modrm();
      const op = rm.reg;
      const a = this.rdOp(rm, sz);
      let b = this.f8();
      if (b & 0x80) b -= 256;
      const r = this.alu(op, a, b, sz);
      if (op !== 7) this.wrOp(rm, sz, r);
    };

    // ---- TEST ----
    O[0x84] = function() { const rm = this.modrm(); this.alu(4, this.rdOp(rm, 8), this.r8(rm.reg), 8); };
    O[0x85] = function() { const rm = this.modrm(); const sz = SZB(); this.alu(4, this.rdOp(rm, sz), this.rdReg(rm.reg, sz), sz); };
    O[0xA8] = function() { this.alu(4, this.r8(0), this.f8(), 8); };
    O[0xA9] = function() { const sz = SZB(); const b = sz === 16 ? this.f16() : this.f32(); this.alu(4, this.rdReg(0, sz), b, sz); };

    // ---- INC / DEC r16/32 ----
    for (let i = 0; i < 8; i++) {
      const r = i;
      O[0x40 + i] = function() {
        const sz = SZB();
        const a = this.rdReg(r, sz);
        const c = this.getF(CF);
        const v = this.alu(0, a, 1, sz);
        if (c) this.setF(CF, 1); else this.setF(CF, 0);
        this.wrReg(r, sz, v);
      };
      O[0x48 + i] = function() {
        const sz = SZB();
        const a = this.rdReg(r, sz);
        const c = this.getF(CF);
        const v = this.alu(5, a, 1, sz);
        if (c) this.setF(CF, 1); else this.setF(CF, 0);
        this.wrReg(r, sz, v);
      };
    }

    // ---- PUSH / POP r16/32 ----
    for (let i = 0; i < 8; i++) {
      const r = i;
      O[0x50 + i] = function() { this.push(this.rdReg(r, SZB())); };
      O[0x58 + i] = function() { this.wrReg(r, SZB(), this.pop()); };
    }

    // ---- PUSH imm ----
    O[0x68] = function() { this.push(this.osize === 16 ? this.f16() : this.f32()); };
    O[0x6A] = function() {
      let v = this.f8();
      if (v & 0x80) v = (v - 256) >>> 0;
      this.push(v);
    };

    // ---- IMUL r, r/m, imm ----
    O[0x69] = function() {
      const sz = SZB();
      const rm = this.modrm();
      const a = this.rdOp(rm, sz);
      const imm = sz === 16 ? this.f16() : this.f32();
      this.wrReg(rm.reg, sz, Number(BigInt.asUintN(sz, this._imul(sz, a, imm))));
    };
    O[0x6B] = function() {
      const sz = SZB();
      const rm = this.modrm();
      const a = this.rdOp(rm, sz);
      let imm = this.f8();
      if (imm & 0x80) imm = (imm | (sz === 16 ? 0xFF00 : 0xFFFFFF00)) >>> 0;   // sign-extend imm8
      this.wrReg(rm.reg, sz, Number(BigInt.asUintN(sz, this._imul(sz, a, imm))));
    };

    // ---- INS / OUTS (186+) ----
    O[0x6C] = function() { // INSB
      const doIn = () => {
        const v = this.ioRead(this.r16(2), 1) & 0xFF;
        this.wr8(ES, this.r16(7), v);
        this.w16(7, (this.r16(7) + (this.getF(DF) ? -1 : 1)) & 0xFFFF);
      };
      if (this.rep) { while (this.r16(1) !== 0) { doIn(); this.w16(1, this.r16(1) - 1); } }
      else doIn();
    };
    O[0x6D] = function() { // INSW/INSD
      const sz = SZB();
      const step = sz / 8;
      const doIn = () => {
        const v = this.ioRead(this.r16(2), sz);
        this.wrOp({isReg:false,seg:ES,addr:this.r16(7)}, sz, v);
        this.w16(7, (this.r16(7) + (this.getF(DF) ? -1 : 1) * step) & 0xFFFF);
      };
      if (this.rep) { while (this.r16(1) !== 0) { doIn(); this.w16(1, this.r16(1) - 1); } }
      else doIn();
    };
    O[0x6E] = function() { // OUTSB
      const doOut = () => {
        const v = this.rd8(this.segOvr>=0?this.segOvr:3, this.r16(6));
        this.ioWrite(this.r16(2), 1, v);
        this.w16(6, (this.r16(6) + (this.getF(DF) ? -1 : 1)) & 0xFFFF);
      };
      if (this.rep) { while (this.r16(1) !== 0) { doOut(); this.w16(1, this.r16(1) - 1); } }
      else doOut();
    };
    O[0x6F] = function() { // OUTSW/OUTSD
      const sz = SZB();
      const step = sz / 8;
      const doOut = () => {
        const v = this.rdOp({isReg:false,seg:this.segOvr>=0?this.segOvr:3,addr:this.r16(6)}, sz);
        this.ioWrite(this.r16(2), sz, v);
        this.w16(6, (this.r16(6) + (this.getF(DF) ? -1 : 1) * step) & 0xFFFF);
      };
      if (this.rep) { while (this.r16(1) !== 0) { doOut(); this.w16(1, this.r16(1) - 1); } }
      else doOut();
    };

    // ---- PUSH / POP sreg ----
    O[0x06] = function() { this.push(this.sregs[ES]); };
    O[0x07] = function() { this.sregs[ES] = this.pop() & 0xFFFF; };
    O[0x0E] = function() { this.push(this.sregs[CS]); };
    O[0x16] = function() { this.push(this.sregs[SS]); };
    O[0x17] = function() { this.sregs[SS] = this.pop() & 0xFFFF; };
    O[0x1E] = function() { this.push(this.sregs[DS]); };
    O[0x1F] = function() { this.sregs[DS] = this.pop() & 0xFFFF; };

    // ---- POP r/m (0x8F) ----
    O[0x8F] = function() {
      const rm = this.modrm();
      const sz = SZB();
      const v = this.pop();
      this.wrOp(rm, sz, v);
    };

    // ---- ENTER / LEAVE (186+) ----
    O[0xC8] = function() { // ENTER imm16, imm8
      const size = this.f16();
      const level = this.f8() & 0x1F;
      this.push(this.r16(5));           // push BP
      const frame = this.r16(4);
      if (level > 0) {
        for (let i = 1; i < level; i++) {
          this.w16(5, this.r16(5) - 2);
          this.push(this.rd16(SS, this.r16(5)));
        }
        this.push(frame);
      }
      this.w16(5, frame);
      this.w16(4, this.r16(4) - size);
    };
    O[0xC9] = function() { // LEAVE
      this.w16(4, this.r16(5));
      this.w16(5, this.pop());
    };

    // ---- Group 2: shifts / rotates ----
    const doShift = function(op, sz, count, target) {
      const mask = sz === 8 ? 0xFF : sz === 16 ? 0xFFFF : 0xFFFFFFFF;
      const signBit = sz === 8 ? 0x80 : sz === 16 ? 0x8000 : 0x80000000;
      const bits = sz;
      let v = target & mask;
      const old = v;
      count = count & (sz === 8 ? 0x1F : 0x1F);
      if (count === 0) return v;

      let oldCF = this.getF(CF);
      const cfMask = 1 << (bits - 1);
      let cf = 0, of = 0;

      switch (op) {
        case 0: { // ROL
          const rot = count % bits;
          v = rot === 0 ? v >>> 0 : ((v << rot) | (v >>> (bits - rot))) >>> 0;   // >>> 0: 32 bits sem sinal
          if (bits < 32) v &= mask;
          cf = (v & 1);
          of = ((v >>> (bits - 1)) ^ cf) & 1;
          break;
        }
        case 1: { // ROR
          const rot = count % bits;
          v = rot === 0 ? v >>> 0 : ((v >>> rot) | (v << (bits - rot))) >>> 0;
          if (bits < 32) v &= mask;
          cf = (v >>> (bits - 1)) & 1;
          of = ((v >>> (bits - 1)) ^ (v >>> (bits - 2))) & 1;
          break;
        }
        case 2: { // RCL
          for (let i = 0; i < count; i++) {
            const newCF = (v & cfMask) ? 1 : 0;
            v = ((v << 1) | oldCF) & mask;
            cf = newCF;
            oldCF = cf;
          }
          of = ((v >>> (bits - 1)) ^ cf) & 1;
          break;
        }
        case 3: { // RCR
          for (let i = 0; i < count; i++) {
            const newCF = v & 1;
            v = ((v >>> 1) | (oldCF ? cfMask : 0)) & mask;
            cf = newCF;
            oldCF = cf;
          }
          of = ((v >>> (bits - 1)) ^ (v >>> (bits - 2))) & 1;
          break;
        }
        case 4: case 6: { // SHL / SAL
          if (count >= bits) {
            cf = count === bits ? (v & 1) : 0;
            v = 0;
          } else {
            cf = (v >>> (bits - count)) & 1;
            v = (v << count) & mask;
          }
          of = ((v >>> (bits - 1)) ^ cf) & 1;
          break;
        }
        case 5: { // SHR
          if (count >= bits) {
            cf = count === bits ? ((v >>> (bits - 1)) & 1) : 0;
            v = 0;
          } else {
            cf = (v >>> (count - 1)) & 1;
            v = v >>> count;
          }
          of = (old >>> (bits - 1)) & 1;
          break;
        }
        case 7: { // SAR
          const sign = (old & signBit) ? -1 : 0;
          if (count >= bits) {
            cf = (old & signBit) ? 1 : 0;
            v = sign ? mask : 0;
          } else {
            cf = (old >>> (count - 1)) & 1;
            // sinal
            if (sign) {
              v = (old >> count) | (mask & ~((1 << (bits - count)) - 1));
            } else {
              v = old >>> count;
            }
            v &= mask;
          }
          of = 0;
          break;
        }
      }
      this.setF(CF, cf);
      this.setF(OF, of);
      // ZF, SF, PF só nos deslocamentos (SHL/SHR/SAR); ROL/ROR/RCL/RCR não mexem neles
      if (op >= 4) {
        this.setF(ZF, v === 0);
        this.setF(SF, (v & signBit) ? 1 : 0);
        this.setF(PF, PF_TABLE[v & 0xFF] ? 1 : 0);
      }
      return v;
    };

    const mkShift = (sz, countSrc) => function() {
      const rm = this.modrm();
      const op = rm.reg;
      let count;
      if (countSrc === 'imm') count = this.f8();
      else if (countSrc === 'cl') count = this.r8(1);
      else count = 1;
      const a = this.rdOp(rm, sz);
      const r = doShift.call(this, op, sz, count, a);
      this.wrOp(rm, sz, r);
    };

    O[0xC0] = mkShift(8, 'imm');
    O[0xC1] = function() {
      const sz = SZB();
      const rm = this.modrm();
      const op = rm.reg;
      const count = this.f8();
      const a = this.rdOp(rm, sz);
      const r = doShift.call(this, op, sz, count, a);
      this.wrOp(rm, sz, r);
    };
    O[0xD0] = mkShift(8, 1);
    O[0xD1] = function() {
      const sz = SZB();
      const rm = this.modrm();
      const op = rm.reg;
      const a = this.rdOp(rm, sz);
      const r = doShift.call(this, op, sz, 1, a);
      this.wrOp(rm, sz, r);
    };
    O[0xD2] = mkShift(8, 'cl');
    O[0xD3] = function() {
      const sz = SZB();
      const rm = this.modrm();
      const op = rm.reg;
      const count = this.r8(1);
      const a = this.rdOp(rm, sz);
      const r = doShift.call(this, op, sz, count, a);
      this.wrOp(rm, sz, r);
    };

    // ---- Group 3 ----
    O[0xF6] = function() { this._group3(8); };
    O[0xF7] = function() { this._group3(SZB()); };

    // ---- Group 5 ----
    O[0xFE] = function() { this._group5(8); };
    O[0xFF] = function() { this._group5(SZB()); };

    // ---- Jcc rel8 ----
    for (let i = 0; i < 16; i++) {
      const cond = conds[i];
      O[0x70 + i] = function() {
        const d = this.f8();
        const rel = (d & 0x80) ? d - 256 : d;
        if (cond.call(this)) this.ip = (this.ip + rel) & 0xFFFF;
      };
    }

    // ---- JMP / CALL / RET ----
    O[0xEB] = function() { const d = this.f8(); const rel = (d & 0x80) ? d - 256 : d; this.ip = (this.ip + rel) & 0xFFFF; };
    O[0xE9] = function() {
      if (this.osize === 16) {
        const d = this.f16();
        const rel = (d & 0x8000) ? d - 0x10000 : d;
        this.ip = (this.ip + rel) & 0xFFFF;
      } else {
        const d = this.f32() | 0;
        this.ip = (this.ip + d) & 0xFFFF;
      }
    };
    O[0xEA] = function() {
      const off = this.f16();
      const seg = this.f16();
      this.ip = off;
      this.sregs[CS] = seg;
    };
    O[0xE8] = function() {
      if (this.osize === 16) {
        const d = this.f16();
        const rel = (d & 0x8000) ? d - 0x10000 : d;
        this.push(this.ip);
        this.ip = (this.ip + rel) & 0xFFFF;
      } else {
        const d = this.f32() | 0;
        this.push(this.ip);
        this.ip = (this.ip + d) & 0xFFFF;
      }
    };
    O[0x9A] = function() {
      const off = this.f16();
      const seg = this.f16();
      this.push(this.sregs[CS]);
      this.push(this.ip);
      this.sregs[CS] = seg;
      this.ip = off;
    };
    O[0xC3] = function() { this.ip = this.pop() & 0xFFFF; };
    O[0xC2] = function() { const n = this.f16(); this.ip = this.pop() & 0xFFFF; this.w16(4, this.r16(4) + n); };
    O[0xCB] = function() { this.ip = this.pop() & 0xFFFF; this.sregs[CS] = this.pop() & 0xFFFF; };
    O[0xCA] = function() { const n = this.f16(); this.ip = this.pop() & 0xFFFF; this.sregs[CS] = this.pop() & 0xFFFF; this.w16(4, this.r16(4) + n); };

    // ---- LOOP / JCXZ ----
    // Intel: E0 = LOOPNE/LOOPNZ, E1 = LOOPE/LOOPZ, E2 = LOOP, E3 = JCXZ
    O[0xE0] = function() { const d = this.f8(); const rel = (d & 0x80) ? d - 256 : d; this.w16(1, this.r16(1) - 1); if (this.r16(1) !== 0 && !this.getF(ZF)) this.ip = (this.ip + rel) & 0xFFFF; };
    O[0xE1] = function() { const d = this.f8(); const rel = (d & 0x80) ? d - 256 : d; this.w16(1, this.r16(1) - 1); if (this.r16(1) !== 0 && this.getF(ZF)) this.ip = (this.ip + rel) & 0xFFFF; };
    O[0xE2] = function() { const d = this.f8(); const rel = (d & 0x80) ? d - 256 : d; this.w16(1, this.r16(1) - 1); if (this.r16(1) !== 0) this.ip = (this.ip + rel) & 0xFFFF; };
    O[0xE3] = function() { const d = this.f8(); const rel = (d & 0x80) ? d - 256 : d; if (this.r16(1) === 0) this.ip = (this.ip + rel) & 0xFFFF; };

    // ---- INT / IRET / INTO ----
    O[0xCC] = function() { if (this.intHandler) this.intHandler.call(this, 3); };
    O[0xCD] = function() { const n = this.f8(); if (this.intHandler) this.intHandler.call(this, n); };
    O[0xCE] = function() { if (this.getF(OF)) { if (this.intHandler) this.intHandler.call(this, 4); } };
    O[0xCF] = function() {
      this.ip = this.pop() & 0xFFFF;
      this.sregs[CS] = this.pop() & 0xFFFF;
      this.flags = (this.pop() | 0x2) & 0x3F7FD5;
    };

    // ---- IN / OUT ----
    O[0xE4] = function() { this.w8(0, this.ioRead(this.f8(), 1) & 0xFF); };
    O[0xE5] = function() { const p = this.f8(); this.wrReg(0, SZB(), this.ioRead(p, SZB())); };
    O[0xE6] = function() { const p = this.f8(); this.ioWrite(p, 1, this.r8(0)); };
    O[0xE7] = function() { const p = this.f8(); this.ioWrite(p, SZB(), this.rdReg(0, SZB())); };
    O[0xEC] = function() { this.w8(0, this.ioRead(this.r16(2), 1) & 0xFF); };
    O[0xED] = function() { const p = this.r16(2); this.wrReg(0, SZB(), this.ioRead(p, SZB())); };
    O[0xEE] = function() { this.ioWrite(this.r16(2), 1, this.r8(0)); };
    O[0xEF] = function() { this.ioWrite(this.r16(2), SZB(), this.rdReg(0, SZB())); };

    // ---- XLAT ----
    O[0xD7] = function() { this.w8(0, this.rd8(this.segOvr>=0?this.segOvr:3, (this.r16(3) + this.r8(0)) & 0xFFFF)); };

    // ---- BCD / ASCII adjust ----
    O[0x27] = function() { // DAA
      let al = this.r8(0);
      const oldAL = al;
      const oldCF = this.getF(CF);
      let cf = 0;
      if ((al & 0x0F) > 9 || this.getF(AF)) {
        al += 6;
        cf = oldCF | ((al & 0xFF) < oldAL ? 1 : 0);
        this.setF(AF, 1);
      } else this.setF(AF, 0);
      if (oldAL > 0x99 || oldCF) { al += 0x60; cf = 1; }
      al &= 0xFF;
      this.w8(0, al);
      this.setF(CF, cf);
      this.setF(ZF, al === 0);
      this.setF(SF, (al & 0x80) ? 1 : 0);
      this.setF(PF, PF_TABLE[al] ? 1 : 0);
    };
    O[0x2F] = function() { // DAS
      let al = this.r8(0);
      const oldAL = al;
      const oldCF = this.getF(CF);
      let cf = 0;
      if ((al & 0x0F) > 9 || this.getF(AF)) {
        al -= 6;
        cf = oldCF | (al < 0 ? 1 : 0);
        this.setF(AF, 1);
      } else this.setF(AF, 0);
      if (oldAL > 0x99 || oldCF) { al -= 0x60; cf = 1; }
      al &= 0xFF;
      this.w8(0, al);
      this.setF(CF, cf);
      this.setF(ZF, al === 0);
      this.setF(SF, (al & 0x80) ? 1 : 0);
      this.setF(PF, PF_TABLE[al] ? 1 : 0);
    };
    O[0x37] = function() { // AAA
      let al = this.r8(0);
      let ah = this.r8(4);
      let cf = 0, af = 0;
      if ((al & 0x0F) > 9 || this.getF(AF)) {
        al = (al + 6) & 0xFF;
        ah = (ah + 1) & 0xFF;
        af = 1; cf = 1;
      }
      al &= 0x0F;
      this.w8(0, al); this.w8(4, ah);
      this.setF(AF, af); this.setF(CF, cf);
    };
    O[0x3F] = function() { // AAS
      let al = this.r8(0);
      let ah = this.r8(4);
      let cf = 0, af = 0;
      if ((al & 0x0F) > 9 || this.getF(AF)) {
        al = (al - 6) & 0xFF;
        ah = (ah - 1) & 0xFF;
        af = 1; cf = 1;
      }
      al &= 0x0F;
      this.w8(0, al); this.w8(4, ah);
      this.setF(AF, af); this.setF(CF, cf);
    };
    O[0xD4] = function() { // AAM
      const base = this.f8();
      let al = this.r8(0);
      const ah = Math.floor(al / base) & 0xFF;
      al = (al % base) & 0xFF;
      this.w8(4, ah); this.w8(0, al);
      this.setF(SF, (al & 0x80) ? 1 : 0);
      this.setF(ZF, al === 0);
      this.setF(PF, PF_TABLE[al] ? 1 : 0);
      this.setF(CF, 0); this.setF(OF, 0); this.setF(AF, 0);
    };
    O[0xD5] = function() { // AAD
      const base = this.f8();
      let al = this.r8(0);
      const ah = this.r8(4);
      al = (al + ah * base) & 0xFF;
      this.w8(0, al); this.w8(4, 0);
      this.setF(SF, (al & 0x80) ? 1 : 0);
      this.setF(ZF, al === 0);
      this.setF(PF, PF_TABLE[al] ? 1 : 0);
      this.setF(CF, 0); this.setF(OF, 0); this.setF(AF, 0);
    };
    O[0xD6] = function() { this.w8(0, this.getF(CF) ? 0xFF : 0x00); }; // SALC
    O[0x9B] = function() {}; // FWAIT
    O[0xF1] = function() { if (this.intHandler) this.intHandler.call(this, 1); };

    // ---- String ops ----
    // REP/REPE/REPNE. Só CMPS e SCAS (cmp=true) consultam o ZF: REPE (F3, rep=3) para quando ZF=0 e
    // REPNE (F2, rep=2) para quando ZF=1. MOVS/STOS/LODS/INS/OUTS repetem até CX=0, seja qual for o prefixo.
    const doRep = function(cb, cmp) {
      if (!this.rep) { cb.call(this); return; }
      for (;;) {
        const cx = this.r16(1);
        if (cx === 0) break;
        cb.call(this);
        this.w16(1, cx - 1);
        if (cmp) {
          const zf = this.getF(ZF);
          if (this.rep === 3 ? !zf : zf) break;
        }
      }
    };
    const doRepCmp = function(cb) { return doRep.call(this, cb, true); };
    O[0xA4] = function() {
      doRep.call(this, function() {
        this.wr8(ES, this.r16(7), this.rd8(this.segOvr>=0?this.segOvr:3, this.r16(6)));
        const d = this.getF(DF) ? -1 : 1;
        this.w16(6, (this.r16(6) + d) & 0xFFFF);
        this.w16(7, (this.r16(7) + d) & 0xFFFF);
      });
    };
    O[0xA5] = function() {
      const sz = SZB();
      doRep.call(this, function() {
        this.wrOp({isReg:false,seg:ES,addr:this.r16(7)}, sz,
                  this.rdOp({isReg:false,seg:this.segOvr>=0?this.segOvr:3,addr:this.r16(6)}, sz));
        const d = (this.getF(DF) ? -1 : 1) * (sz / 8);
        this.w16(6, (this.r16(6) + d) & 0xFFFF);
        this.w16(7, (this.r16(7) + d) & 0xFFFF);
      });
    };
    O[0xAA] = function() {
      doRep.call(this, function() {
        this.wr8(ES, this.r16(7), this.r8(0));
        this.w16(7, (this.r16(7) + (this.getF(DF) ? -1 : 1)) & 0xFFFF);
      });
    };
    O[0xAB] = function() {
      const sz = SZB();
      doRep.call(this, function() {
        this.wrOp({isReg:false,seg:ES,addr:this.r16(7)}, sz, this.rdReg(0, sz));
        this.w16(7, (this.r16(7) + (this.getF(DF) ? -1 : 1) * (sz/8)) & 0xFFFF);
      });
    };
    O[0xAC] = function() {
      doRep.call(this, function() {
        this.w8(0, this.rd8(this.segOvr>=0?this.segOvr:3, this.r16(6)));
        this.w16(6, (this.r16(6) + (this.getF(DF) ? -1 : 1)) & 0xFFFF);
      });
    };
    O[0xAD] = function() {
      const sz = SZB();
      doRep.call(this, function() {
        this.wrReg(0, sz, this.rdOp({isReg:false,seg:this.segOvr>=0?this.segOvr:3,addr:this.r16(6)}, sz));
        this.w16(6, (this.r16(6) + (this.getF(DF) ? -1 : 1) * (sz/8)) & 0xFFFF);
      });
    };
    O[0xA6] = function() {
      doRepCmp.call(this, function() {
        const a = this.rd8(this.segOvr>=0?this.segOvr:3, this.r16(6));
        const b = this.rd8(ES, this.r16(7));
        this.alu(7, a, b, 8);
        const d = this.getF(DF) ? -1 : 1;
        this.w16(6, (this.r16(6) + d) & 0xFFFF);
        this.w16(7, (this.r16(7) + d) & 0xFFFF);
      });
    };
    O[0xA7] = function() {
      const sz = SZB();
      doRepCmp.call(this, function() {
        const a = this.rdOp({isReg:false,seg:this.segOvr>=0?this.segOvr:3,addr:this.r16(6)}, sz);
        const b = this.rdOp({isReg:false,seg:ES,addr:this.r16(7)}, sz);
        this.alu(7, a, b, sz);
        const d = (this.getF(DF) ? -1 : 1) * (sz/8);
        this.w16(6, (this.r16(6) + d) & 0xFFFF);
        this.w16(7, (this.r16(7) + d) & 0xFFFF);
      });
    };
    O[0xAE] = function() {
      doRepCmp.call(this, function() {
        const a = this.r8(0);
        const b = this.rd8(ES, this.r16(7));
        this.alu(7, a, b, 8);
        this.w16(7, (this.r16(7) + (this.getF(DF) ? -1 : 1)) & 0xFFFF);
      });
    };
    O[0xAF] = function() {
      const sz = SZB();
      doRepCmp.call(this, function() {
        const a = this.rdReg(0, sz);
        const b = this.rdOp({isReg:false,seg:ES,addr:this.r16(7)}, sz);
        this.alu(7, a, b, sz);
        this.w16(7, (this.r16(7) + (this.getF(DF) ? -1 : 1) * (sz/8)) & 0xFFFF);
      });
    };

    // ============================================================
    // 0x0F — prefixo estendido
    // ============================================================
    O[0x0F] = function() {
      const op2 = this.f8();
      const sz = SZB();
      const mask = sz === 16 ? 0xFFFF : 0xFFFFFFFF;

      if (op2 >= 0x80 && op2 <= 0x8F) {
        const ci = op2 - 0x80;
        let d, rel;
        if (this.osize === 16) {
          d = this.f16();
          rel = (d & 0x8000) ? d - 0x10000 : d;
        } else {
          d = this.f32();
          rel = d | 0;
        }
        if (conds[ci].call(this)) this.ip = (this.ip + rel) & 0xFFFF;
        return;
      }
      if (op2 >= 0x90 && op2 <= 0x9F) {
        const rm = this.modrm();
        const ci = op2 - 0x90;
        this.wrOp(rm, 8, conds[ci].call(this) ? 1 : 0);
        return;
      }
      if (op2 >= 0x40 && op2 <= 0x4F) {
        const rm = this.modrm();
        const ci = op2 - 0x40;
        if (conds[ci].call(this)) this.wrReg(rm.reg, sz, this.rdOp(rm, sz));
        return;
      }

      switch (op2) {
        case 0x00: case 0x01: this.modrm(); break;
        case 0x02: case 0x03: {
          const rm = this.modrm();
          this.wrReg(rm.reg, sz, 0);
          this.setF(ZF, 1);
          break;
        }
        case 0x05: break;
        case 0x06: break;
        case 0x08: break;
        case 0x09: break;
        case 0x0B: throw new Error('UD2 executado');
        case 0x0D: this.modrm(); break;
        case 0x0E: break;
        case 0x18: case 0x19: case 0x1A: case 0x1B:
        case 0x1C: case 0x1D: case 0x1E: case 0x1F:
          this.modrm(); break;
        case 0x20: {
          const rm = this.modrm();
          let v = 0;
          if (rm.reg === 0) v = 0x10;
          this.wrReg(rm.rm, 32, v);
          break;
        }
        case 0x21: { const rm = this.modrm(); this.wrReg(rm.rm, 32, 0); break; }
        case 0x22: this.modrm(); break;
        case 0x23: this.modrm(); break;
        case 0x30: break;
        case 0x31: {
          const t = BigInt(Date.now()) * 1000n;
          this.w32(0, Number(t & 0xFFFFFFFFn));
          this.w32(2, Number((t >> 32n) & 0xFFFFFFFFn));
          break;
        }
        case 0x32: this.w32(0, 0); this.w32(2, 0); break;
        case 0xA0: this.push(this.sregs[4]); break;
        case 0xA1: this.sregs[4] = this.pop() & 0xFFFF; break;
        case 0xA2: {
          const leaf = this.r32(0);
          if (leaf === 0) {
            this.w32(0, 1);
            this.w32(1, 0x756E6547);
            this.w32(2, 0x49656E69);
            this.w32(3, 0x6C65746E);
          } else if (leaf === 1) {
            this.w32(0, 0x000106A5);
            this.w32(1, 0); this.w32(2, 0); this.w32(3, 0);
          } else {
            this.w32(0, 0); this.w32(1, 0); this.w32(2, 0); this.w32(3, 0);
          }
          break;
        }
        case 0xA3: {
          const rm = this.modrm();
          const bit = this.rdReg(rm.reg, sz) & (sz - 1);
          const v = this.rdOp(rm, sz);
          this.setF(CF, (v >> bit) & 1);
          break;
        }
        case 0xA4: { const rm = this.modrm(); this._shd(rm, sz, true, this.f8()); break; }
        case 0xA5: { const rm = this.modrm(); this._shd(rm, sz, true, this.r8(1)); break; }
        case 0xA8: this.push(this.sregs[5]); break;
        case 0xA9: this.sregs[5] = this.pop() & 0xFFFF; break;
        case 0xAB: {
          const rm = this.modrm();
          const bit = this.rdReg(rm.reg, sz) & (sz - 1);
          const v = this.rdOp(rm, sz);
          this.setF(CF, (v >> bit) & 1);
          this.wrOp(rm, sz, v | (1 << bit));
          break;
        }
        case 0xAC: { const rm = this.modrm(); this._shd(rm, sz, false, this.f8()); break; }
        case 0xAD: { const rm = this.modrm(); this._shd(rm, sz, false, this.r8(1)); break; }
        case 0xAE: this.modrm(); break;
        case 0xAF: {
          const rm = this.modrm();
          const a = this.rdReg(rm.reg, sz);
          const b = this.rdOp(rm, sz);
          this.wrReg(rm.reg, sz, Number(BigInt.asUintN(sz, this._imul(sz, a, b))));
          break;
        }
        case 0xB0: {
          const rm = this.modrm();
          const dst = this.rdOp(rm, 8);
          const src = this.r8(rm.reg);
          const acc = this.r8(0);
          if (acc === dst) { this.setF(ZF, 1); this.wrOp(rm, 8, src); }
          else { this.setF(ZF, 0); this.w8(0, dst); }
          break;
        }
        case 0xB1: {
          const rm = this.modrm();
          const dst = this.rdOp(rm, sz);
          const src = this.rdReg(rm.reg, sz);
          const acc = this.rdReg(0, sz);
          if (acc === dst) { this.setF(ZF, 1); this.wrOp(rm, sz, src); }
          else { this.setF(ZF, 0); this.wrReg(0, sz, dst); }
          break;
        }
        case 0xB2: {
          const rm = this.modrm();
          const lo = this.rdOp(rm, 16);
          const hi = this.rd16(rm.seg, (rm.addr + 2) & 0xFFFF);
          this.wrReg(rm.reg, sz, lo);
          this.sregs[2] = hi;
          break;
        }
        case 0xB3: {
          const rm = this.modrm();
          const bit = this.rdReg(rm.reg, sz) & (sz - 1);
          const v = this.rdOp(rm, sz);
          this.setF(CF, (v >> bit) & 1);
          this.wrOp(rm, sz, v & ~(1 << bit));
          break;
        }
        case 0xB4: case 0xB5: {
          const rm = this.modrm();
          const lo = this.rdOp(rm, 16);
          const hi = this.rd16(rm.seg, (rm.addr + 2) & 0xFFFF);
          this.wrReg(rm.reg, sz, lo);
          this.sregs[op2 === 0xB4 ? 4 : 5] = hi;
          break;
        }
        case 0xB6: {
          const rm = this.modrm();
          this.wrReg(rm.reg, sz, this.rdOp(rm, 8));
          break;
        }
        case 0xB7: {
          const rm = this.modrm();
          this.wrReg(rm.reg, sz, this.rdOp(rm, 16));
          break;
        }
        case 0xBA: {
          const rm = this.modrm();
          const sub = rm.reg;
          const bit = this.f8() & (sz - 1);
          const v = this.rdOp(rm, sz);
          this.setF(CF, (v >> bit) & 1);
          if (sub === 5) this.wrOp(rm, sz, v | (1 << bit));
          else if (sub === 6) this.wrOp(rm, sz, v & ~(1 << bit));
          else if (sub === 7) this.wrOp(rm, sz, v ^ (1 << bit));
          break;
        }
        case 0xBB: {
          const rm = this.modrm();
          const bit = this.rdReg(rm.reg, sz) & (sz - 1);
          const v = this.rdOp(rm, sz);
          this.setF(CF, (v >> bit) & 1);
          this.wrOp(rm, sz, v ^ (1 << bit));
          break;
        }
        case 0xBC: {
          const rm = this.modrm();
          const v = this.rdOp(rm, sz);
          if (v === 0) this.setF(ZF, 1);
          else {
            this.setF(ZF, 0);
            let i = 0; while (!((v >> i) & 1)) i++;
            this.wrReg(rm.reg, sz, i);
          }
          break;
        }
        case 0xBD: {
          const rm = this.modrm();
          const v = this.rdOp(rm, sz);
          if (v === 0) this.setF(ZF, 1);
          else {
            this.setF(ZF, 0);
            let i = sz - 1; while (!((v >> i) & 1)) i--;
            this.wrReg(rm.reg, sz, i);
          }
          break;
        }
        case 0xBE: {
          const rm = this.modrm();
          const v = this.rdOp(rm, 8);
          const s = (v & 0x80) ? (v | 0xFFFFFF00) >>> 0 : v;
          this.wrReg(rm.reg, sz, s);
          break;
        }
        case 0xBF: {
          const rm = this.modrm();
          const v = this.rdOp(rm, 16);
          const s = (v & 0x8000) ? (v | 0xFFFF0000) >>> 0 : v;
          this.wrReg(rm.reg, sz, s);
          break;
        }
        case 0xC0: {
          const rm = this.modrm();
          const a = this.rdOp(rm, 8);
          const b = this.r8(rm.reg);
          const r = this.alu(0, a, b, 8);
          this.wrOp(rm, 8, r);
          this.w8(rm.reg, a);
          break;
        }
        case 0xC1: {
          const rm = this.modrm();
          const a = this.rdOp(rm, sz);
          const b = this.rdReg(rm.reg, sz);
          const r = this.alu(0, a, b, sz);
          this.wrOp(rm, sz, r);
          this.wrReg(rm.reg, sz, a);
          break;
        }
        case 0xC7: {
          const rm = this.modrm();
          if (rm.reg === 1) {
            const lo = this.rdOp(rm, 32);
            const hi = this.rd32(rm.seg, (rm.addr + 4) & 0xFFFF);
            if (this.r32(0) === lo && this.r32(2) === hi) {
              this.setF(ZF, 1);
            } else {
              this.setF(ZF, 0);
              this.w32(0, lo); this.w32(2, hi);
            }
          }
          break;
        }
        case 0xC8: case 0xC9: case 0xCA: case 0xCB:
        case 0xCC: case 0xCD: case 0xCE: case 0xCF: {
          const r = op2 & 7;
          const v = this.r32(r);
          const b = (((v & 0xFF) << 24) |
                     (((v >> 8) & 0xFF) << 16) |
                     (((v >> 16) & 0xFF) << 8) |
                     ((v >> 24) & 0xFF)) >>> 0;
          this.w32(r, b);
          break;
        }
        default:
          this._ud();                                        // 0F xx inexistente no 8086/386: #UD (INT 6)
      }
    };
  }

  /** Divide error (#DE): entrega INT 0 como o hardware; sem handler, interrompe com erro. */
  _divFault() {
    if (this.intHandler) this.intHandler.call(this, 0);
    else throw new Error('Divide error');
  }

  /**
   * IMUL com sinal: a e b são valores crus de `sz` bits (8/16/32). Devolve o produto completo (BigInt)
   * e ajusta CF=OF=1 quando o resultado não cabe, com sinal, em `sz` bits.
   */
  _imul(sz, a, b) {
    const p = BigInt.asIntN(sz, BigInt(a >>> 0)) * BigInt.asIntN(sz, BigInt(b >>> 0));
    const ovf = BigInt.asIntN(sz, p) !== p ? 1 : 0;
    this.setF(CF, ovf); this.setF(OF, ovf);
    return p;
  }

  /**
   * SHLD/SHRD (386+). Flags como no hardware: CF = último bit expulso; OF (contagem 1) = mudança de sinal;
   * SF/ZF/PF do resultado; AF indefinido/intacto. Contagem mascarada em 5 bits; 0 não altera nada.
   * Tudo com BigInt para 32 bits sem sinal (o & do JS quebraria o bit 31).
   */
  _shd(rm, sz, left, cnt) {
    cnt &= 31;
    if (cnt === 0) return;
    const A = BigInt(this.rdOp(rm, sz) >>> 0), B = BigInt(this.rdReg(rm.reg, sz) >>> 0);
    const S = BigInt(sz), M = (1n << S) - 1n, C = BigInt(cnt);
    if (cnt > sz) cnt = sz;
    let r, cf;
    if (left) { r = Number((((A << S) | B) << C >> S) & M); cf = Number((A >> (S - C)) & 1n); }
    else      { r = Number((((B << S) | A) >> C) & M);       cf = Number((A >> (C - 1n)) & 1n); }
    r = r >>> 0;
    this.wrOp(rm, sz, r);
    const a = Number(A);
    const sign = sz === 32 ? 0x80000000 : 0x8000;
    let f = this.flags & ~(CF | PF | ZF | SF | OF);
    if (cf) f |= CF;
    if (((a ^ r) >>> (sz - 1)) & 1) f |= OF;
    f |= PF_TABLE[r & 0xFF];
    if (r === 0) f |= ZF;
    if (r & sign) f |= SF;
    this.flags = f;
  }

  /**
   * Exceção de opcode inválido (#UD, INT 6). Empilha o IP da instrução que falhou. Sem handler instalado
   * (CPU isolada nos testes), lança erro para não mascarar o problema.
   */
  _ud() {
    if (this.intHandler) {
      if (this._insStart !== undefined) this.ip = this._insStart;
      this.intHandler.call(this, 6);
      return;
    }
    throw new Error(`Opcode inválido (#UD) em ${this.sregs[CS].toString(16)}:${(this._insStart ?? this.ip).toString(16)}`);
  }

  _group3(sz) {
    const rm = this.modrm();
    const op = rm.reg;
    const a = this.rdOp(rm, sz);
    const mask = sz === 8 ? 0xFF : sz === 16 ? 0xFFFF : 0xFFFFFFFF;
    switch (op) {
      case 0: {
        const b = sz === 8 ? this.f8() : sz === 16 ? this.f16() : this.f32();
        this.alu(4, a, b, sz);
        break;
      }
      case 2: this.wrOp(rm, sz, (~a) & mask); break;
      case 3: {
        const r = this.alu(5, 0, a, sz);
        this.setF(CF, a !== 0 ? 1 : 0);
        this.wrOp(rm, sz, r);
        break;
      }
      case 4: {
        if (sz === 8) {
          const r = this.r8(0) * a;
          this.w16(0, r & 0xFFFF);
          this.setF(CF, r > 0xFF ? 1 : 0);
          this.setF(OF, this.getF(CF));
        } else if (sz === 16) {
          const r = this.r16(0) * a;
          this.w16(0, r & 0xFFFF);
          this.w16(2, (r >>> 16) & 0xFFFF);
          this.setF(CF, r > 0xFFFF ? 1 : 0);
          this.setF(OF, this.getF(CF));
        } else {
          const r = BigInt(this.r32(0)) * BigInt(a);
          this.w32(0, Number(r & 0xFFFFFFFFn));
          this.w32(2, Number((r >> 32n) & 0xFFFFFFFFn));
          this.setF(CF, r > 0xFFFFFFFFn ? 1 : 0);
          this.setF(OF, this.getF(CF));
        }
        break;
      }
      case 5: {
        if (sz === 8) {
          const p = Number(this._imul(8, this.r8(0), a));
          this.w16(0, p & 0xFFFF);
        } else if (sz === 16) {
          const p = Number(this._imul(16, this.r16(0), a));
          this.w16(0, p & 0xFFFF);
          this.w16(2, (p >> 16) & 0xFFFF);
        } else {
          const p = this._imul(32, this.r32(0), a);
          this.w32(0, Number(BigInt.asUintN(32, p)));
          this.w32(2, Number(BigInt.asUintN(32, p >> 32n)));
        }
        break;
      }
      case 6: {
        if (a === 0) { this._divFault(); break; }
        if (sz === 8) {
          const n = this.r16(0), q = Math.floor(n / a);
          if (q > 0xFF) { this._divFault(); break; }
          this.w8(0, q);
          this.w8(4, n % a);
        } else if (sz === 16) {
          const n = this.r16(2) * 65536 + this.r16(0), q = Math.floor(n / a);   // sem << (evita inteiro com sinal)
          if (q > 0xFFFF) { this._divFault(); break; }
          this.w16(0, q);
          this.w16(2, n % a);
        } else {
          const n = (BigInt(this.r32(2)) << 32n) | BigInt(this.r32(0));
          const q = n / BigInt(a);
          if (q > 0xFFFFFFFFn) { this._divFault(); break; }
          const rem = n % BigInt(a);
          this.w32(0, Number(q & 0xFFFFFFFFn));
          this.w32(2, Number(rem & 0xFFFFFFFFn));
        }
        break;
      }
      case 7: {
        if (a === 0) { this._divFault(); break; }
        if (sz === 8) {
          const n = (this.r16(0) << 16) >> 16;
          const d = (a << 24) >> 24;
          const q = Math.trunc(n / d);
          if (q > 127 || q < -128) { this._divFault(); break; }
          this.w8(0, q & 0xFF);
          this.w8(4, (n % d) & 0xFF);
        } else if (sz === 16) {
          const n = ((this.r16(2) << 16) | this.r16(0)) | 0;
          const d = (a << 16) >> 16;
          const q = Math.trunc(n / d);
          if (q > 32767 || q < -32768) { this._divFault(); break; }
          this.w16(0, q & 0xFFFF);
          this.w16(2, (n % d) & 0xFFFF);
        } else {
          const n = BigInt.asIntN(64, (BigInt(this.r32(2)) << 32n) | BigInt(this.r32(0)));
          const d = BigInt(a | 0);
          const q = n / d;
          if (q > 0x7FFFFFFFn || q < -0x80000000n) { this._divFault(); break; }
          this.w32(0, Number(BigInt.asUintN(32, q)));
          this.w32(2, Number(BigInt.asUintN(32, n % d)));
        }
        break;
      }
    }
  }

  _group5(sz) {
    const rm = this.modrm();
    const op = rm.reg;
    switch (op) {
      case 0: {
        const a = this.rdOp(rm, sz);
        const c = this.getF(CF);
        const r = this.alu(0, a, 1, sz);
        if (c) this.setF(CF, 1); else this.setF(CF, 0);
        this.wrOp(rm, sz, r);
        break;
      }
      case 1: {
        const a = this.rdOp(rm, sz);
        const c = this.getF(CF);
        const r = this.alu(5, a, 1, sz);
        if (c) this.setF(CF, 1); else this.setF(CF, 0);
        this.wrOp(rm, sz, r);
        break;
      }
      case 2: {
        const t = this.rdOp(rm, sz);
        this.push(this.ip);
        this.ip = t & 0xFFFF;
        break;
      }
      case 3:   // CALL FAR m16:16  (FF /3): lê offset:segmento da memória ANTES de empilhar
      case 5: { // JMP  FAR m16:16  (FF /5): era inexistente — o boot sector do FreeDOS salta ao kernel assim
        if (rm.isReg) { this._ud(); break; }
        const w = sz === 32 ? 4 : 2;
        const off = sz === 32 ? this.rd32(rm.seg, rm.addr) : this.rd16(rm.seg, rm.addr);
        const seg = this.rd16(rm.seg, (rm.addr + w) & 0xFFFF);
        if (op === 3) { this.push(this.sregs[CS]); this.push(this.ip); }
        this.sregs[CS] = seg;
        this.ip = off & 0xFFFF;
        break;
      }
      case 4: {
        const t = this.rdOp(rm, sz);
        this.ip = t & 0xFFFF;
        break;
      }
      case 6: {
        const v = this.rdOp(rm, sz);
        this.push(v);
        break;
      }
    }
  }
}