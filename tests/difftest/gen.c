// Gera vetores de teste executando as instruções NO HARDWARE REAL (x86-64, user mode).
// Registro de 16 bytes: {op|w<<8, a, b, cnt, fin, res, fout, aux} (u16 little-endian).
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
typedef struct { uint16_t f[8]; } Rec;
static FILE *out; static long nrec;
enum { ADD, OR, ADC, SBB, AND, SUB, XOR, CMP, TEST, INC, DEC, NEG, NOT, ROL, ROR, RCL, RCR, SHL, SHR, SAR, MUL, IMUL, DIV, IDIV };
#define FM 0x8D5
static void emit(int op, int w, uint16_t a, uint16_t b, uint16_t cnt, uint16_t fin, uint16_t res, uint16_t fout, uint16_t aux) {
  Rec r = {{ (uint16_t)(op | (w << 8)), a, b, cnt, fin, res, fout, aux }}; fwrite(&r, sizeof r, 1, out); nrec++; }

#define BIN(W, T, SUF, NAME, INSN) static void NAME##W(T a, T b, uint16_t fin, T *r, uint16_t *fo) { \
  uint64_t fl; T res = a; \
  __asm__ volatile("pushq %[fin]\n\tpopfq\n\t" INSN SUF " %[b], %[res]\n\tpushfq\n\tpopq %[fl]" \
    : [res] "+q"(res), [fl] "=r"(fl) : [b] "q"(b), [fin] "r"((uint64_t)fin) : "cc", "memory"); \
  *r = res; *fo = fl & FM; }
#define UNA(W, T, SUF, NAME, INSN) static void NAME##W(T a, uint16_t fin, T *r, uint16_t *fo) { \
  uint64_t fl; T res = a; \
  __asm__ volatile("pushq %[fin]\n\tpopfq\n\t" INSN SUF " %[res]\n\tpushfq\n\tpopq %[fl]" \
    : [res] "+q"(res), [fl] "=r"(fl) : [fin] "r"((uint64_t)fin) : "cc", "memory"); \
  *r = res; *fo = fl & FM; }
#define SHF(W, T, SUF, NAME, INSN) static void NAME##W(T a, uint8_t cnt, uint16_t fin, T *r, uint16_t *fo) { \
  uint64_t fl; T res = a; \
  __asm__ volatile("pushq %[fin]\n\tpopfq\n\t" INSN SUF " %%cl, %[res]\n\tpushfq\n\tpopq %[fl]" \
    : [res] "+q"(res), [fl] "=r"(fl) : "c"(cnt), [fin] "r"((uint64_t)fin) : "cc", "memory"); \
  *r = res; *fo = fl & FM; }
#define ALLBIN(W, T, SUF) BIN(W,T,SUF,add,"add") BIN(W,T,SUF,or_,"or") BIN(W,T,SUF,adc,"adc") BIN(W,T,SUF,sbb,"sbb") \
  BIN(W,T,SUF,and_,"and") BIN(W,T,SUF,sub,"sub") BIN(W,T,SUF,xor_,"xor") BIN(W,T,SUF,cmp,"cmp") BIN(W,T,SUF,test,"test") \
  UNA(W,T,SUF,inc,"inc") UNA(W,T,SUF,dec,"dec") UNA(W,T,SUF,neg,"neg") UNA(W,T,SUF,not_,"not") \
  SHF(W,T,SUF,rol,"rol") SHF(W,T,SUF,ror,"ror") SHF(W,T,SUF,rcl,"rcl") SHF(W,T,SUF,rcr,"rcr") \
  SHF(W,T,SUF,shl,"shl") SHF(W,T,SUF,shr,"shr") SHF(W,T,SUF,sar,"sar")
ALLBIN(8, uint8_t, "b")
ALLBIN(16, uint16_t, "w")

static uint16_t rnd16(void) { return (uint16_t)(rand() ^ (rand() << 7)); }
static const uint16_t EDGE16[] = {0,1,2,3,0x7F,0x80,0x81,0xFF,0x100,0x7FFF,0x8000,0x8001,0xFFFF,0xFFFE,0x00FF,0xFF00,0x0F,0x10,0x1F,0xF0,0x0FFF,0x1000,0x5555,0xAAAA,0x7F7F,0x8080};
#define NEDGE (sizeof EDGE16 / sizeof *EDGE16)
static uint16_t FP[4] = {0x002, 0x002|0x4|0x40, 0x002|0x10|0x80, 0x002|0x800|0x4|0x10};   // padrões de flags iniciais (sem CF)

int main(int argc, char **argv) {
  out = fopen(argv[1], "wb"); srand(12345);
  // ---------- ALU binária ----------
  for (int w = 8; w <= 16; w += 8) {
    int n = w == 8 ? 256 : (int)NEDGE + 90;
    for (int i = 0; i < n; i++) for (int j = 0; j < n; j++) {
      uint16_t a = w == 8 ? i : (i < (int)NEDGE ? EDGE16[i] : rnd16()), b = w == 8 ? j : (j < (int)NEDGE ? EDGE16[j] : rnd16());
      for (int cf = 0; cf < 2; cf++) { uint16_t fin = FP[(i + j) & 3] | cf; uint16_t fo, r16; uint8_t r8;
#define DO(OP, F) if (w == 8) { F##8((uint8_t)a, (uint8_t)b, fin, &r8, &fo); r16 = r8; } else F##16(a, b, fin, &r16, &fo); emit(OP, w, a, b, 0, fin, r16, fo, 0);
        DO(ADD, add) DO(OR, or_) DO(ADC, adc) DO(SBB, sbb) DO(AND, and_) DO(SUB, sub) DO(XOR, xor_) DO(CMP, cmp) DO(TEST, test)
      }
    }
  }
  // ---------- unárias ----------
  for (int w = 8; w <= 16; w += 8) { int n = w == 8 ? 256 : 3000;
    for (int i = 0; i < n; i++) { uint16_t a = w == 8 ? i : (i < (int)NEDGE ? EDGE16[i] : rnd16());
      for (int cf = 0; cf < 2; cf++) for (int p = 0; p < 4; p++) { uint16_t fin = FP[p] | cf, fo, r16; uint8_t r8;
#define UN(OP, F) if (w == 8) { F##8((uint8_t)a, fin, &r8, &fo); r16 = r8; } else F##16(a, fin, &r16, &fo); emit(OP, w, a, 0, 0, fin, r16, fo, 0);
        UN(INC, inc) UN(DEC, dec) UN(NEG, neg) UN(NOT, not_) } } }
  // ---------- rotações e deslocamentos (contagem em CL) ----------
  for (int w = 8; w <= 16; w += 8) { int n = w == 8 ? 256 : 600;
    for (int i = 0; i < n; i++) { uint16_t a = w == 8 ? i : (i < (int)NEDGE ? EDGE16[i] : rnd16());
      for (int cf = 0; cf < 2; cf++) for (int p = 0; p < 2; p++) {
        for (int cnt = 0; cnt <= 31; cnt++) { uint16_t fin = FP[p * 3] | cf, fo, r16; uint8_t r8;
#define SH(OP, F) if (w == 8) { F##8((uint8_t)a, cnt, fin, &r8, &fo); r16 = r8; } else F##16(a, cnt, fin, &r16, &fo); emit(OP, w, a, 0, cnt, fin, r16, fo, 0);
          SH(ROL, rol) SH(ROR, ror) SH(RCL, rcl) SH(RCR, rcr)
          if (cnt < w) { SH(SHL, shl) SH(SHR, shr) SH(SAR, sar) } } } } }
  // ---------- MUL / IMUL (8 e 16 bits) ----------
  for (int i = 0; i < 65536; i++) for (int s = 0; s < 1; s++) { uint16_t ax = i, b = (uint8_t)(rnd16()); if (i % 256 == 0) b = (uint8_t)(i / 256);
    for (int k = 0; k < 2; k++) { uint16_t r = ax; uint64_t fl;
      if (k == 0) __asm__ volatile("pushq $2\n\tpopfq\n\tmulb %[b]\n\tpushfq\n\tpopq %[fl]" : "+a"(r), [fl] "=r"(fl) : [b] "q"((uint8_t)b) : "cc", "memory");
      else __asm__ volatile("pushq $2\n\tpopfq\n\timulb %[b]\n\tpushfq\n\tpopq %[fl]" : "+a"(r), [fl] "=r"(fl) : [b] "q"((uint8_t)b) : "cc", "memory");
      emit(k ? IMUL : MUL, 8, ax, b, 0, 2, r, fl & FM, 0); } }
  for (int i = 0; i < 120000; i++) { uint16_t ax = i < (int)NEDGE * 20 ? EDGE16[i % NEDGE] : rnd16(), b = i < (int)NEDGE * 20 ? EDGE16[(i / NEDGE) % NEDGE] : rnd16();
    for (int k = 0; k < 2; k++) { uint16_t r = ax, dx = 0; uint64_t fl;
      if (k == 0) __asm__ volatile("pushq $2\n\tpopfq\n\tmulw %[b]\n\tpushfq\n\tpopq %[fl]" : "+a"(r), "+d"(dx), [fl] "=r"(fl) : [b] "r"(b) : "cc", "memory");
      else __asm__ volatile("pushq $2\n\tpopfq\n\timulw %[b]\n\tpushfq\n\tpopq %[fl]" : "+a"(r), "+d"(dx), [fl] "=r"(fl) : [b] "r"(b) : "cc", "memory");
      emit(k ? IMUL : MUL, 16, ax, b, 0, 2, r, fl & FM, dx); } }
  // ---------- DIV / IDIV (sem overflow/zero; flags indefinidos: só resultado) ----------
  for (int i = 0; i < 200000; i++) { uint16_t ax = rnd16(); uint8_t b = (uint8_t)rnd16(); if (!b) continue;
    if (ax / b <= 255) { uint16_t r = ax; __asm__ volatile("divb %[b]" : "+a"(r) : [b] "q"(b) : "cc"); emit(DIV, 8, ax, b, 0, 2, r, 0, 0); }
    int q = (int16_t)ax / (int8_t)b; if (q >= -127 && q <= 127) { uint16_t r = ax; __asm__ volatile("idivb %[b]" : "+a"(r) : [b] "q"(b) : "cc"); emit(IDIV, 8, ax, b, 0, 2, r, 0, 0); } }
  for (int i = 0; i < 200000; i++) { uint16_t ax = rnd16(), dx = rnd16() >> (rand() % 16), b = rnd16() | 1; if (rand() % 3 == 0) b >>= rand() % 16; if (!b) continue;
    uint32_t n = ((uint32_t)dx << 16) | ax; if (n / b <= 0xFFFF) { uint16_t r = ax, d = dx; __asm__ volatile("divw %[b]" : "+a"(r), "+d"(d) : [b] "r"(b) : "cc"); emit(DIV, 16, ax, b, dx, 2, r, 0, d); }
    int32_t sn = (int32_t)n, sq = sn / (int16_t)b; if (sq >= -32767 && sq <= 32767) { uint16_t r = ax, d = dx; __asm__ volatile("idivw %[b]" : "+a"(r), "+d"(d) : [b] "r"(b) : "cc"); emit(IDIV, 16, ax, b, dx, 2, r, 0, d); } }
  fclose(out); fprintf(stderr, "%ld vetores\n", nrec); return 0; }
