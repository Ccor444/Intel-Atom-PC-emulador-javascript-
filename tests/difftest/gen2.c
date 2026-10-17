// Fuzz de instruções com operandos em REGISTRADOR (todas as combinações ModRM, inclusive AH/CH/DH/BH),
// executadas no hardware real. Registro: 24 × u16.
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
typedef struct { uint64_t r[7]; uint64_t fl; } St;
void native_run(St *in, St *out, void *code);
static uint16_t rnd16(void) { return (uint16_t)(rand() ^ (rand() << 7)); }
static const uint16_t EDGE[] = {0,1,2,0x7F,0x80,0xFF,0x100,0x7FFF,0x8000,0xFFFF,0x00FF,0xFF00,0x0F,0x10,0x8080,0x7F7F,0x1234,0xFFFE};
static uint16_t val(void) { return (rand() % 3 == 0) ? EDGE[rand() % (sizeof EDGE / sizeof *EDGE)] : rnd16(); }
static int R8(void) { return rand() & 7; }
static int R16(void) { int r; do r = rand() & 7; while (r == 4); return r; }   // sem SP
enum { C_FULL, C_LOGIC, C_ROT, C_SHIFT, C_MUL };
static const uint8_t BASE[8] = {0x00,0x08,0x10,0x18,0x20,0x28,0x30,0x38};
static int gen(uint8_t *c, int *w16, int *cls) {
  *cls = C_FULL; int k = rand() % 12, n = 0;
  switch (k) {
  case 0: { uint8_t b = BASE[rand() % 8]; *w16 = rand() & 1; c[n++] = b + (rand() & 1 ? 2 : 0) + *w16;
    int rr = *w16 ? R16() : R8(), rm = *w16 ? R16() : R8(); c[n++] = 0xC0 | rr << 3 | rm; if (b == 0x08 || b == 0x20 || b == 0x30) *cls = C_LOGIC; return n; }
  case 1: { static const uint8_t o[] = {0x84,0x86,0x88,0x8A}; int i = rand() % 4; *w16 = rand() & 1; c[n++] = o[i] + *w16;
    int rr = *w16 ? R16() : R8(), rm = *w16 ? R16() : R8(); c[n++] = 0xC0 | rr << 3 | rm; if (i == 0) *cls = C_LOGIC; return n; }
  case 2: { int op = rand() % 8, t = rand() % 3; *w16 = t != 0; c[n++] = t == 0 ? 0x80 : t == 1 ? 0x81 : 0x83;
    int rm = *w16 ? R16() : R8(); c[n++] = 0xC0 | op << 3 | rm; if (t == 1) { uint16_t v = val(); c[n++] = v; c[n++] = v >> 8; } else c[n++] = val();
    if (op == 1 || op == 4 || op == 6) *cls = C_LOGIC; return n; }
  case 3: { if (rand() & 1) { c[n++] = 0xB0 + R8(); c[n++] = val(); *w16 = 0; } else { c[n++] = 0xB8 + R16(); uint16_t v = val(); c[n++] = v; c[n++] = v >> 8; *w16 = 1; } return n; }
  case 4: { *w16 = rand() & 1; c[n++] = 0xFE + *w16; int rm = *w16 ? R16() : R8(); c[n++] = 0xC0 | (rand() & 1) << 3 | rm; return n; }
  case 5: { *w16 = rand() & 1; c[n++] = 0xF6 + *w16; int op = rand() % 6, rm = *w16 ? R16() : R8(); if (op == 1) op = 0;
    c[n++] = 0xC0 | op << 3 | rm; if (op == 0) { *cls = C_LOGIC; if (*w16) { uint16_t v = val(); c[n++] = v; c[n++] = v >> 8; } else c[n++] = val(); }
    if (op >= 4) *cls = C_MUL; return n; }
  case 6: { c[n++] = 0x90 + 1 + (rand() % 7); if (c[0] == 0x94) c[0] = 0x95; *w16 = 1; return n; }
  case 7: { int t = rand() % 3, op; do op = rand() & 7; while (op == 6); *w16 = rand() & 1;
    c[n++] = t == 0 ? 0xC0 + *w16 : t == 1 ? 0xD0 + *w16 : 0xD2 + *w16; int rm = *w16 ? R16() : R8(); c[n++] = 0xC0 | op << 3 | rm; if (t == 0) c[n++] = rand() % 32;
    *cls = op < 4 ? C_ROT : C_SHIFT; return n; }
  case 8: { static const uint8_t o[] = {0x98,0x99,0x9E,0x9F,0xF5,0xF8,0xF9}; c[n++] = o[rand() % 7]; *w16 = c[0] <= 0x99; return n; }
  case 9: { *w16 = 1; if (rand() & 1) { c[n++] = 0x0F; c[n++] = 0xAF; } else { c[n++] = rand() & 1 ? 0x69 : 0x6B; }
    int rr = R16(), rm = R16(); if (c[0] != 0x0F) { c[n++] = 0xC0 | rr << 3 | rm; if (c[0] == 0x69) { uint16_t v = val(); c[n++] = v; c[n++] = v >> 8; } else c[n++] = val(); } else c[n++] = 0xC0 | rr << 3 | rm;
    *cls = C_MUL; return n; }
  case 10: { static const uint8_t o[] = {0xB6,0xB7,0xBE,0xBF}; int i = rand() % 4; *w16 = 1; c[n++] = 0x0F; c[n++] = o[i];
    int rr = R16(), rm = (i & 1) ? R16() : R8(); c[n++] = 0xC0 | rr << 3 | rm; return n; }
  default: { *w16 = 1; c[n++] = 0x8D; c[n++] = 0xC0; return n; }   // LEA reg,reg é #UD: substituído abaixo
  } }
int main(int argc, char **argv) {
  FILE *out = fopen(argv[1], "wb"); long N = atol(argv[2]); srand(777); long wrote = 0;
  uint8_t *buf = mmap(0, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  while (wrote < N) {
    uint8_t c[8]; int w16, cls; int len = gen(c, &w16, &cls);
    if (c[0] == 0x8D) continue;
    St in, o; memset(&in, 0, sizeof in); for (int i = 0; i < 7; i++) in.r[i] = val();
    uint16_t fin = 2 | (rand() & 0x8D5); in.fl = fin;
    int pos = 0; if (w16) buf[pos++] = 0x66; memcpy(buf + pos, c, len); pos += len; buf[pos++] = 0xC3;
    native_run(&in, &o, buf);
    uint16_t cl = (uint16_t)in.r[1] & 0xFF; int cnt = 0;
    if (cls == C_ROT || cls == C_SHIFT) { int t = c[0] & 0xFE; cnt = t == 0xC0 ? c[2] : t == 0xD0 ? 1 : cl; cnt &= 31; }
    uint16_t rec[24] = {0}; rec[0] = len; rec[1] = w16; for (int i = 0; i < 3; i++) rec[2 + i] = c[2 * i] | (c[2 * i + 1] << 8); rec[5] = cls;
    for (int i = 0; i < 7; i++) { rec[6 + i] = (uint16_t)in.r[i]; rec[14 + i] = (uint16_t)o.r[i]; }
    rec[13] = fin; rec[21] = (uint16_t)(o.fl & 0x8D5); rec[22] = cnt; fwrite(rec, sizeof rec, 1, out); wrote++;
  }
  fclose(out); fprintf(stderr, "%ld vetores\n", wrote); return 0; }
