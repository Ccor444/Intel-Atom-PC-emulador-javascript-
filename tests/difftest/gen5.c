// Fuzz de instruções com OPERANDO DE MEMÓRIA ([SI+d8] [DI+d8] [BP+d8] [BX+d8]; 8/16/32 bits) no hardware real.
// Compara registradores, flags E memória. Nativo: base = ponteiro de 64 bits; JS: base = offset 16 bits equivalente.
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
typedef struct { uint64_t r[7]; uint64_t fl; } St;          // rax rcx rdx rbx rbp rsi rdi
void native_run(St *in, St *out, void *code);
typedef struct { uint32_t nlen, jlen; uint8_t nat[16], js[16]; uint32_t cls, cnt, w, fin, fout, rin[3], rout[3]; uint8_t min[128], mout[128]; } Rec;
static uint32_t rnd32(void) { return ((uint32_t)rand() << 17) ^ ((uint32_t)rand() << 6) ^ (uint32_t)rand(); }
static const uint32_t EDGE[] = {0,1,2,0x7F,0x80,0xFF,0x100,0x7FFF,0x8000,0xFFFF,0x10000,0x7FFFFFFF,0x80000000,0xFFFFFFFF,0xFFFF0000,0x0000FFFF,0x1A00001B,0x001A001B};
static uint32_t val(void) { return (rand() % 3 == 0) ? EDGE[rand() % (sizeof EDGE / sizeof *EDGE)] : rnd32(); }
enum { C_FULL, C_LOGIC, C_ROT, C_SHIFT, C_MUL, C_SHD, C_BT };
static const uint8_t BASE[8] = {0x00,0x08,0x10,0x18,0x20,0x28,0x30,0x38};
static const uint8_t RMN[4] = {6, 7, 5, 3}, RMJ[4] = {4, 5, 6, 7};      // SI DI BP BX: rm nativo (rsi rdi rbp rbx) e rm 16 bits
static int w, base, reg, disp, cls, cnt_src;
static uint8_t pre[8], post[16]; static int npre, npost, nopx;
static void imm(int bytes, uint32_t v) { for (int i = 0; i < bytes; i++) post[npost++] = v >> (8 * i); }
static int gen(void) {                         // preenche pre[] (opcode), reg/opx em 'reg', post[] (imediato); w já escolhido
  cls = C_FULL; npre = npost = 0; int k = rand() % 14; int big = w != 8; reg = rand() % 3;
  switch (k) {
  case 0: { uint8_t b = BASE[rand() % 8]; pre[npre++] = b + (rand() & 1 ? 2 : 0) + big; if (b == 0x08 || b == 0x20 || b == 0x30) cls = C_LOGIC; return 1; }
  case 1: { static const uint8_t o[] = {0x84,0x86,0x88,0x8A}; int i = rand() % 4; pre[npre++] = o[i] + big; if (i == 0) cls = C_LOGIC; return 1; }
  case 2: { int op = rand() % 8; if (w == 8) { pre[npre++] = 0x80; imm(1, val()); } else if (rand() & 1) { pre[npre++] = 0x81; imm(w / 8, val()); } else { pre[npre++] = 0x83; imm(1, val()); } reg = op; if (op == 1 || op == 4 || op == 6) cls = C_LOGIC; return 1; }
  case 3: { pre[npre++] = 0xC6 + big; reg = 0; imm(w / 8, val()); return 1; }
  case 4: { pre[npre++] = 0xFE + big; reg = rand() & 1; return 1; }
  case 5: { int op = rand() % 6; if (op == 1) op = 0; pre[npre++] = 0xF6 + big; reg = op; if (op == 0) { cls = C_LOGIC; imm(w / 8, val()); } if (op >= 4) cls = C_MUL; return 1; }
  case 6: { int t = rand() % 3, op; do op = rand() & 7; while (op == 6); pre[npre++] = (t == 0 ? 0xC0 : t == 1 ? 0xD0 : 0xD2) + big; reg = op; if (t == 0) imm(1, rand() % 32); cls = op < 4 ? C_ROT : C_SHIFT; cnt_src = t; return 1; }
  case 7: { if (w == 8) return 0; static const uint8_t o[] = {0xB6,0xB7,0xBE,0xBF}; int i = rand() % 4; if (w == 16 && (i & 1)) i &= ~1; pre[npre++] = 0x0F; pre[npre++] = o[i]; return 1; }
  case 8: { if (w == 8) return 0; int t = rand() % 3; if (t == 0) { pre[npre++] = 0x0F; pre[npre++] = 0xAF; } else if (t == 1) { pre[npre++] = 0x69; imm(w / 8, val()); } else { pre[npre++] = 0x6B; imm(1, val()); } cls = C_MUL; return 1; }
  case 9: { if (w == 8) return 0; int t = rand() % 4; pre[npre++] = 0x0F; pre[npre++] = t == 0 ? 0xA4 : t == 1 ? 0xAC : t == 2 ? 0xA5 : 0xAD; if (t < 2) imm(1, rand() % (w)); cls = C_SHD; return 1; }
  case 10: { if (w == 8) return 0; pre[npre++] = 0x0F; pre[npre++] = 0xBA; reg = 4 + rand() % 4; imm(1, rand() % w); cls = C_BT; return 1; }
  case 11: { if (w == 8) return 0; pre[npre++] = 0x0F; pre[npre++] = 0x40 + rand() % 16; return 1; }
  case 12: { if (w != 8) return 0; pre[npre++] = 0x0F; pre[npre++] = 0x90 + rand() % 16; reg = 0; return 1; }
  default: { pre[npre++] = 0xA8; npre = 0; return 0; }
  } }
int main(int argc, char **argv) {
  FILE *out = fopen(argv[1], "wb"); long N = atol(argv[2]); srand(2468); long wrote = 0;
  uint8_t *buf = mmap(0, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  while (wrote < N) {
    w = (int[]){8, 16, 32}[rand() % 3]; if (!gen()) continue;
    base = rand() % 4; disp = (rand() % 41) - 16;
    Rec r; memset(&r, 0, sizeof r);
    // bytes nativos: [66 se w16] opcode modrm(mod01, reg, rm nativo) disp8 imm ; bytes JS: [66 se w32] opcode modrm(rm 16 bits) disp8 imm
    int n = 0, j = 0;
    if (w == 16) r.nat[n++] = 0x66; if (w == 32) r.js[j++] = 0x66;
    for (int i = 0; i < npre; i++) { r.nat[n++] = pre[i]; r.js[j++] = pre[i]; }
    r.nat[n++] = 0x40 | reg << 3 | RMN[base]; r.js[j++] = 0x40 | reg << 3 | RMJ[base];
    r.nat[n++] = disp; r.js[j++] = disp;
    for (int i = 0; i < npost; i++) { r.nat[n++] = post[i]; r.js[j++] = post[i]; }
    r.nat[n] = 0xC3; r.nlen = n; r.jlen = j; r.cls = cls; r.w = w;
    uint8_t wb[256]; for (int i = 0; i < 128; i++) wb[i] = (rand() % 3) ? rand() & 255 : (uint8_t)val();   // janela de 128 bytes; base aponta para o byte 32
    memcpy(r.min, wb, 128);
    St in, o; memset(&in, 0, sizeof in); in.r[0] = val(); in.r[1] = val(); in.r[2] = val();
    uint64_t ptr = (uint64_t)(wb + 32); int idx = base == 0 ? 5 : base == 1 ? 6 : base == 2 ? 4 : 3; in.r[idx] = ptr;   // rsi rdi rbp rbx
    uint32_t fin = 2 | (rand() & 0x8D5); in.fl = fin; memcpy(buf, r.nat, n + 1);
    native_run(&in, &o, buf);
    uint32_t cl = (uint32_t)in.r[1] & 0xFF; int cnt = 0;
    if (cls == C_ROT || cls == C_SHIFT) cnt = cnt_src == 0 ? post[0] : cnt_src == 1 ? 1 : cl, cnt &= 31;
    if (cls == C_SHD) cnt = (pre[1] == 0xA4 || pre[1] == 0xAC) ? post[0] : cl, cnt &= 31;
    if (cls == C_ROT || cls == C_SHIFT) { if (w == 8 && cnt > 7 && cls == C_SHIFT) { wrote += 0; continue; } if (w == 16 && cnt > 15 && cls == C_SHIFT) continue; }
    if (cls == C_SHD && w == 16 && cnt > 16) continue;
    r.cnt = cnt; r.fin = fin; r.fout = (uint32_t)(o.fl & 0x8D5);
    r.rin[0] = (uint32_t)in.r[0]; r.rin[1] = (uint32_t)in.r[1]; r.rin[2] = (uint32_t)in.r[2];
    r.rout[0] = (uint32_t)o.r[0]; r.rout[1] = (uint32_t)o.r[1]; r.rout[2] = (uint32_t)o.r[2];
    memcpy(r.mout, wb, 128); r.cnt = cnt;
    // guarda também o índice da base para o JS: reutiliza r.cls alto
    r.cls |= (uint32_t)base << 8 | (uint32_t)(disp & 0xFF) << 16;
    fwrite(&r, sizeof r, 1, out); wrote++;
  }
  fclose(out); fprintf(stderr, "%ld vetores\n", wrote); return 0; }
