// Fuzz de instruções de 32 BITS com operandos em registrador, executadas no hardware real.
// Registro: 24 × u32. O JS executa os mesmos bytes com o prefixo 66h (modo real, operando de 32 bits).
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
typedef struct { uint64_t r[7]; uint64_t fl; } St;
void native_run(St *in, St *out, void *code);
static uint32_t rnd32(void) { return ((uint32_t)rand() << 17) ^ ((uint32_t)rand() << 6) ^ (uint32_t)rand(); }
static const uint32_t EDGE[] = {0,1,2,0x7F,0x80,0xFF,0x100,0x7FFF,0x8000,0xFFFF,0x10000,0x7FFFFFFF,0x80000000,0xFFFFFFFF,0xFFFF0000,0x0000FFFF,0xFF00FF00,0x12345678,0xFFFFFFFE,0x00010001,0x0001001B};
static uint32_t val(void) { return (rand() % 3 == 0) ? EDGE[rand() % (sizeof EDGE / sizeof *EDGE)] : rnd32(); }
static int R32(void) { int r; do r = rand() & 7; while (r == 4); return r; }
static int R8(void) { return rand() & 7; }
enum { C_FULL, C_LOGIC, C_ROT, C_SHIFT, C_MUL, C_SHD, C_BT, C_BSF };
static const uint8_t BASE[8] = {0x00,0x08,0x10,0x18,0x20,0x28,0x30,0x38};
static void p32(uint8_t *c, int *n, uint32_t v) { for (int i = 0; i < 4; i++) c[(*n)++] = v >> (8 * i); }
static int gen(uint8_t *c, int *cls, uint32_t *srcreg) {
  *cls = C_FULL; *srcreg = 8; int k = rand() % 17, n = 0;
  switch (k) {
  case 0: { uint8_t b = BASE[rand() % 8]; c[n++] = b + 1 + (rand() & 1 ? 2 : 0); c[n++] = 0xC0 | R32() << 3 | R32(); if (b == 0x08 || b == 0x20 || b == 0x30) *cls = C_LOGIC; return n; }
  case 1: { static const uint8_t o[] = {0x85,0x87,0x89,0x8B}; int i = rand() % 4; c[n++] = o[i]; c[n++] = 0xC0 | R32() << 3 | R32(); if (i == 0) *cls = C_LOGIC; return n; }
  case 2: { int op = rand() % 8, t = rand() & 1; c[n++] = t ? 0x81 : 0x83; c[n++] = 0xC0 | op << 3 | R32(); if (t) p32(c, &n, val()); else c[n++] = val(); if (op == 1 || op == 4 || op == 6) *cls = C_LOGIC; return n; }
  case 3: { c[n++] = 0xB8 + R32(); p32(c, &n, val()); return n; }
  case 4: { c[n++] = 0xFF; c[n++] = 0xC0 | (rand() & 1) << 3 | R32(); return n; }
  case 5: { int op = rand() % 6; if (op == 1) op = 0; c[n++] = 0xF7; c[n++] = 0xC0 | op << 3 | R32(); if (op == 0) { *cls = C_LOGIC; p32(c, &n, val()); } if (op >= 4) *cls = C_MUL; return n; }
  case 6: { c[n++] = 0x91 + (rand() % 7); if (c[0] == 0x94) c[0] = 0x95; return n; }
  case 7: { int t = rand() % 3, op; do op = rand() & 7; while (op == 6); c[n++] = t == 0 ? 0xC1 : t == 1 ? 0xD1 : 0xD3; c[n++] = 0xC0 | op << 3 | R32(); if (t == 0) c[n++] = rand() % 32; *cls = op < 4 ? C_ROT : C_SHIFT; return n; }
  case 8: { c[n++] = (rand() & 1) ? 0x98 : 0x99; return n; }
  case 9: { int t = rand() % 3; if (t == 0) { c[n++] = 0x0F; c[n++] = 0xAF; c[n++] = 0xC0 | R32() << 3 | R32(); } else if (t == 1) { c[n++] = 0x69; c[n++] = 0xC0 | R32() << 3 | R32(); p32(c, &n, val()); } else { c[n++] = 0x6B; c[n++] = 0xC0 | R32() << 3 | R32(); c[n++] = val(); } *cls = C_MUL; return n; }
  case 10: { static const uint8_t o[] = {0xB6,0xB7,0xBE,0xBF}; int i = rand() % 4; c[n++] = 0x0F; c[n++] = o[i]; c[n++] = 0xC0 | R32() << 3 | ((i & 1) ? R32() : R8()); return n; }
  case 11: { c[n++] = 0x0F; c[n++] = 0xC8 + R32(); return n; }
  case 12: { int t = rand() % 4; c[n++] = 0x0F; c[n++] = t == 0 ? 0xA4 : t == 1 ? 0xAC : t == 2 ? 0xA5 : 0xAD; c[n++] = 0xC0 | R32() << 3 | R32(); if (t < 2) c[n++] = rand() % 32; *cls = C_SHD; return n; }
  case 13: { static const uint8_t o[] = {0xA3,0xAB,0xB3,0xBB}; c[n++] = 0x0F; c[n++] = o[rand() % 4]; c[n++] = 0xC0 | R32() << 3 | R32(); *cls = C_BT; return n; }
  case 14: { c[n++] = 0x0F; c[n++] = 0xBA; c[n++] = 0xC0 | (4 + rand() % 4) << 3 | R32(); c[n++] = rand() % 32; *cls = C_BT; return n; }
  case 15: { int rr = R32(), rm = R32(); c[n++] = 0x0F; c[n++] = (rand() & 1) ? 0xBC : 0xBD; c[n++] = 0xC0 | rr << 3 | rm; *cls = C_BSF; *srcreg = rm; return n; }
  default: { if (rand() & 1) { c[n++] = 0x0F; c[n++] = 0x40 + rand() % 16; c[n++] = 0xC0 | R32() << 3 | R32(); } else { c[n++] = 0x0F; c[n++] = 0x90 + rand() % 16; c[n++] = 0xC0 | R8(); } return n; }
  } }
int main(int argc, char **argv) {
  FILE *out = fopen(argv[1], "wb"); long N = atol(argv[2]); srand(31337); long wrote = 0;
  uint8_t *buf = mmap(0, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  while (wrote < N) {
    uint8_t c[16]; int cls; uint32_t sr; int len = gen(c, &cls, &sr);
    St in, o; memset(&in, 0, sizeof in); for (int i = 0; i < 7; i++) in.r[i] = val();
    if (sr < 8 && sr != 4) { int idx = sr < 4 ? sr : sr - 1; if (in.r[idx] == 0) in.r[idx] = 1 + (rand() % 100); }   // BSF/BSR: fonte != 0
    uint32_t fin = 2 | (rand() & 0x8D5); in.fl = fin;
    memcpy(buf, c, len); buf[len] = 0xC3;
    native_run(&in, &o, buf);
    uint32_t cl = (uint32_t)in.r[1] & 0xFF; int cnt = 0;
    if (cls == C_ROT || cls == C_SHIFT) { int t = c[0] & 0xFE; cnt = t == 0xC0 ? c[2] : t == 0xD0 ? 1 : cl; cnt &= 31; }
    if (cls == C_SHD) { cnt = (c[1] == 0xA4 || c[1] == 0xAC) ? c[3] : cl; cnt &= 31; }
    uint32_t rec[24] = {0}; rec[0] = len; for (int i = 0; i < 3; i++) rec[1 + i] = c[4 * i] | (c[4 * i + 1] << 8) | (c[4 * i + 2] << 16) | ((uint32_t)c[4 * i + 3] << 24);
    rec[4] = cls; rec[5] = cnt; rec[6] = fin; rec[7] = (uint32_t)(o.fl & 0x8D5);
    for (int i = 0; i < 7; i++) { rec[8 + i] = (uint32_t)in.r[i]; rec[15 + i] = (uint32_t)o.r[i]; }
    fwrite(rec, sizeof rec, 1, out); wrote++;
  }
  fclose(out); fprintf(stderr, "%ld vetores\n", wrote); return 0; }
