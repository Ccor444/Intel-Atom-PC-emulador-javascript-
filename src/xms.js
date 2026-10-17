'use strict';

// ============================================================
// XMS 3.0 (eXtended Memory Specification) em alto nível (HLE)
// ============================================================
// O HimemX real precisa controlar a linha A20 e entrar em modo protegido para mover blocos; a CPU emulada
// só faz modo real. Este módulo faz o papel do driver direto em JS (como emuladores de DOS fazem):
//   • INT 2Fh AX=4300h  → "driver instalado" (AL=80h)
//   • INT 2Fh AX=4310h  → ES:BX = ponto de entrada FAR (stub "INT F2h; RETF" em XMS_ENTRY)
//   • funções XMS (AH) tratadas em call(); a memória estendida é a RAM física acima de 1 MB.
// Sem HMA (função 00h devolve DX=0): o kernel fica na memória convencional e todo o espaço acima de 1 MB
// serve a blocos EMB. Referência: XMS 3.0 specification (Microsoft/Lotus/Intel/AST, 1991).

export const XMS_TRAP_INT = 0xF2;          // INT usado pelo stub de entrada
export const XMS_ENTRY_SEG = 0xEF00;       // stub em EF00:0000 (área de ROMs opcionais, livre)
export const XMS_ENTRY_LIN = XMS_ENTRY_SEG << 4;
const EXT_BASE = 0x100000;                 // sem HMA, a RAM estendida começa em 1 MB
const MAX_HANDLES = 128;

// códigos de erro XMS
const E = {
  NOTIMPL: 0x80, NOHMA: 0x90, HMAINUSE: 0x91, HMANOTALLOC: 0x93, A20ERR: 0x82,
  NOEXT: 0xA0, NOHANDLE: 0xA1, BADHANDLE: 0xA2, BADSRC: 0xA3, BADSRCOFF: 0xA4,
  BADDST: 0xA5, BADDSTOFF: 0xA6, BADLEN: 0xA7, LOCKED: 0xAB, LOCKOVF: 0xAC, LOCKFAIL: 0xAD,
  NOUMB: 0xB1, BADUMB: 0xB2,
};

export class XMS {
  /** @param {object} mem  Memory (com .data e .size)   @param {object} cpu  CPU (para o flag a20) */
  constructor(mem, cpu) {
    this.mem = mem;
    this.cpu = cpu;
    this.reset();
  }

  reset() {
    this.blocks = [];                 // { h, base, kb, locks } ordenado por base
    this.nextHandle = 1;
    this.a20Local = 0;
    this.cpu.a20 = false;
  }

  get endLinear() { return this.mem.size; }
  get totalKB() { return Math.max(0, (this.endLinear - EXT_BASE) >> 10); }

  /** Instala o stub de entrada (INT F2h; RETF) na área de ROMs opcionais. */
  installStub() {
    this.mem.write8(XMS_ENTRY_LIN, 0xCD);
    this.mem.write8(XMS_ENTRY_LIN + 1, XMS_TRAP_INT);
    this.mem.write8(XMS_ENTRY_LIN + 2, 0xCB);
  }

  // ---- alocador (granularidade de 1 KB) -------------------------------------
  _gaps() {
    const gaps = []; let cur = EXT_BASE;
    for (const b of this.blocks) { if (b.base > cur) gaps.push({ base: cur, kb: (b.base - cur) >> 10 }); cur = b.base + (b.kb << 10); }
    if (this.endLinear > cur) gaps.push({ base: cur, kb: (this.endLinear - cur) >> 10 });
    return gaps;
  }
  _largestFreeKB() { return this._gaps().reduce((m, g) => Math.max(m, g.kb), 0); }
  _totalFreeKB() { return this._gaps().reduce((s, g) => s + g.kb, 0); }
  _find(h) { return this.blocks.find((b) => b.h === h); }
  _alloc(kb) {
    if (this.blocks.length >= MAX_HANDLES) return { err: E.NOHANDLE };
    const gap = this._gaps().find((g) => g.kb >= kb);
    if (!gap && kb > 0) return { err: E.NOEXT };
    const base = gap ? gap.base : EXT_BASE;
    const b = { h: this.nextHandle++, base, kb, locks: 0 };
    this.blocks.push(b); this.blocks.sort((x, y) => x.base - y.base);
    return { b };
  }

  // ---- A20 (só reflete no endereçamento da CPU; não há porta 0x92 de propósito) ----
  _a20(on) { this.cpu.a20 = on; }

  // ---- interface com os registradores --------------------------------------
  _ok(c) { c.w16(0, 1); }
  _fail(c, bl) { c.w16(0, 0); c.w8(3, bl); }      // AX=0, BL=erro

  /** Executa a função XMS pedida em AH (registradores da CPU em c). */
  call() {
    const c = this.cpu, ah = c.r16(0) >> 8;
    switch (ah) {
      case 0x00: c.w16(0, 0x0300); c.w16(3, 0x0301); c.w16(2, 0); break;                 // versão 3.00, rev 3.01, sem HMA
      case 0x01: this._fail(c, E.NOHMA); break;
      case 0x02: this._fail(c, E.NOHMA); break;
      case 0x03: case 0x05: this.a20Local++; this._a20(true); this._ok(c); c.w8(3, 0); break;       // habilitar A20 (global/local)
      case 0x04: case 0x06:
        this.a20Local = Math.max(0, this.a20Local - 1); if (this.a20Local === 0) this._a20(false); this._ok(c); c.w8(3, 0); break;
      case 0x07: c.w16(0, this.cpu.a20 ? 1 : 0); c.w8(3, 0); break;                    // consulta A20
      case 0x08: {                                                                       // memória estendida livre
        const big = this._largestFreeKB(), tot = this._totalFreeKB();
        c.w16(0, Math.min(big, 0xFFFF)); c.w16(2, Math.min(tot, 0xFFFF)); c.w8(3, big ? 0 : E.NOEXT); break; }
      case 0x88: {                                                                       // idem, versão 32 bits
        const big = this._largestFreeKB(), tot = this._totalFreeKB();
        c.w32(0, big); c.w32(1, this.endLinear - 1); c.w32(2, tot); c.w8(3, big ? 0 : E.NOEXT); break; }
      case 0x09: case 0x89: {                                                            // alocar EMB
        const kb = ah === 0x09 ? c.r16(2) : c.r32(2);
        const r = this._alloc(kb);
        if (r.err) { this._fail(c, r.err); break; }
        this._ok(c); c.w16(2, r.b.h); break; }
      case 0x0A: {                                                                       // liberar EMB
        const b = this._find(c.r16(2));
        if (!b) { this._fail(c, E.BADHANDLE); break; }
        if (b.locks) { this._fail(c, E.LOCKED); break; }
        this.blocks.splice(this.blocks.indexOf(b), 1); this._ok(c); c.w8(3, 0); break; }
      case 0x0B: this._move(c); break;                                                   // mover bloco
      case 0x0C: {                                                                       // travar EMB: DX:BX = endereço linear
        const b = this._find(c.r16(2));
        if (!b) { this._fail(c, E.BADHANDLE); break; }
        if (b.locks >= 255) { this._fail(c, E.LOCKOVF); break; }
        b.locks++; this._ok(c); c.w16(2, (b.base >>> 16) & 0xFFFF); c.w16(3, b.base & 0xFFFF); break; }
      case 0x0D: {                                                                       // destravar EMB
        const b = this._find(c.r16(2));
        if (!b) { this._fail(c, E.BADHANDLE); break; }
        if (!b.locks) { this._fail(c, E.LOCKFAIL); break; }
        b.locks--; this._ok(c); c.w8(3, 0); break; }
      case 0x0E: case 0x8E: {                                                            // informações do handle
        const b = this._find(c.r16(2));
        if (!b) { this._fail(c, E.BADHANDLE); break; }
        c.w16(0, 1); c.w8(7, b.locks);                                                  // BH = travas
        c.w8(3, Math.min(255, MAX_HANDLES - this.blocks.length));                       // BL = handles livres
        if (ah === 0x0E) c.w16(2, b.kb); else { c.w32(2, b.kb); c.w16(1, MAX_HANDLES - this.blocks.length); }
        break; }
      case 0x0F: case 0x8F: {                                                            // realocar EMB (destravado)
        const b = this._find(c.r16(2)); const kb = ah === 0x0F ? c.r16(3) : c.r32(3);
        if (!b) { this._fail(c, E.BADHANDLE); break; }
        if (b.locks) { this._fail(c, E.LOCKED); break; }
        if (kb <= b.kb) { b.kb = kb; this._ok(c); c.w8(3, 0); break; }
        const old = b, idx = this.blocks.indexOf(b); this.blocks.splice(idx, 1);
        const r = this._alloc(kb);
        if (r.err) { this.blocks.push(old); this.blocks.sort((x, y) => x.base - y.base); this._fail(c, r.err); break; }
        this.mem.data.copyWithin(r.b.base, old.base, old.base + (old.kb << 10));
        r.b.h = old.h; this._ok(c); c.w8(3, 0); break; }
      case 0x10: case 0x12: c.w16(0, 0); c.w8(3, E.NOUMB); c.w16(2, 0); break;           // sem UMBs
      case 0x11: this._fail(c, E.BADUMB); break;
      default: this._fail(c, E.NOTIMPL);
    }
  }

  /** Função 0Bh: DS:SI → { u32 len; u16 srcH; u32 srcOff; u16 dstH; u32 dstOff } */
  _move(c) {
    const a = this.cpu.lin(3, c.r16(6));
    const m = this.mem, len = m.read32(a), sh = m.read16(a + 4), so = m.read32(a + 6), dh = m.read16(a + 10), dof = m.read32(a + 12);
    if (len & 1) { this._fail(c, E.BADLEN); return; }
    const resolve = (h, off, errH, errO) => {
      if (h === 0) {                                                                      // ponteiro real-mode seg:off
        const lin = (((off >>> 16) << 4) + (off & 0xFFFF)) & (this.cpu.a20 ? 0x1FFFFF : 0xFFFFF);
        return lin + len <= m.size ? { lin } : { err: errO };
      }
      const b = this._find(h);
      if (!b) return { err: errH };
      if (off + len > (b.kb << 10)) return { err: errO };
      return { lin: b.base + off };
    };
    const s = resolve(sh, so, E.BADSRC, E.BADSRCOFF); if (s.err) { this._fail(c, s.err); return; }
    const d = resolve(dh, dof, E.BADDST, E.BADDSTOFF); if (d.err) { this._fail(c, d.err); return; }
    m.data.copyWithin(d.lin, s.lin, s.lin + len);                                         // memmove (sobreposição segura)
    this._ok(c); c.w8(3, 0);
  }

  // ---- INT 2Fh: detecção do driver ----------------------------------------
  /** @returns {boolean} true se tratou */
  int2f() {
    const c = this.cpu, ax = c.r16(0);
    if (ax === 0x4300) { c.w8(0, 0x80); return true; }
    if (ax === 0x4310) { c.sregs[0] = XMS_ENTRY_SEG; c.w16(3, 0); return true; }
    return false;
  }

  // ---- INT 4Bh: VDS (Virtual DMA Services) com endereçamento físico = linear -------------------------
  // Sem paginação/EMM386, o endereço físico de um buffer é seg*16+off. Drivers como o LBACACHE travam a região
  // por VDS antes de entregá-la ao DMA; aqui "travar" só informa o endereço (não há tradução nem cópia).
  /** @returns {boolean} true se tratou */
  int4b() {
    const c = this.cpu, ax = c.r16(0), m = this.mem, CF = 1;
    if ((ax >> 8) !== 0x81) return false;                                      // só a família VDS (AH=81h)
    const ok = () => { c.setF(CF, 0); return true; };
    const err = (code) => { c.w8(0, code); c.setF(CF, 1); return true; };
    const dds = this.cpu.lin(0, c.r16(7));                                       // ES:DI
    const linOf = () => ((m.read16(dds + 8) << 4) + m.read32(dds + 4)) >>> 0;
    switch (ax & 0xFF) {
      case 0x02: c.w16(0, 0x0100); c.w16(3, 0); c.w16(1, 0); c.w16(6, 0); c.w16(7, 0); c.w16(2, 0); return ok();  // v1.0, sem buffer
      case 0x03: m.write16(dds + 0x0A, 0); m.write32(dds + 0x0C, linOf()); return ok();                           // travar região
      case 0x04: return ok();                                                                                     // destravar
      case 0x05: {                                                                                                // travar com scatter/gather
        const max = m.read16(dds + 0x0C); if (max < 1) return err(0x09);
        m.write16(dds + 0x0E, 1); m.write32(dds + 0x10, linOf()); m.write32(dds + 0x14, m.read32(dds)); return ok(); }
      case 0x06: return ok();
      case 0x07: return err(0x04);                                                                                // sem buffer de DMA
      case 0x08: return err(0x0A);
      case 0x09: case 0x0A: return err(0x0B);
      case 0x0B: case 0x0C: return ok();                                                                          // desabilitar/habilitar tradução
      default: return err(0x0F);                                                                                  // função não suportada
    }
  }

  // ---- INT 15h: memória estendida para quem não usa XMS ---------------------
  /** @returns {boolean} true se tratou (as demais funções seguem para a ROM) */
  int15() {
    const c = this.cpu, ah = c.r16(0) >> 8, m = this.mem;
    const CF = 1;
    if (ah === 0x88) {                                                                  // KB acima de 1 MB (até 64 MB)
      const kb = Math.min(this.totalKB, 0xFFFF); c.w16(0, kb); c.setF(CF, 0); return true;
    }
    if (ah === 0xE8 && (c.r16(0) & 0xFF) === 0x01) {                                      // AX=E801h
      const low = Math.min(this.totalKB, 0x3C00);                                       // 1 MB..16 MB em KB
      const hi = Math.max(0, (m.size - 0x1000000) >> 16);                                // acima de 16 MB em blocos de 64 KB
      c.w16(0, low); c.w16(1, low); c.w16(3, hi); c.w16(2, hi); c.setF(CF, 0); return true;
    }
    if (ah === 0x87) {                                                                  // copiar bloco (GDT em ES:SI)
      const g = this.cpu.lin(0, c.r16(6)), words = c.r16(1);
      const base = (o) => m.read8(g + o) | (m.read8(g + o + 1) << 8) | (m.read8(g + o + 2) << 16) | (m.read8(g + o + 5) << 24);   // o = início da base (descritor+2); byte alto = descritor+7
      const src = base(0x12) >>> 0, dst = base(0x1A) >>> 0, len = words * 2;
      if (src + len > m.size || dst + len > m.size) { c.w8(4, 0x03); c.setF(CF, 1); return true; }   // erro de A20/endereço
      m.data.copyWithin(dst, src, src + len); c.w8(4, 0); c.setF(CF, 0); return true;
    }
    return false;
  }
}
