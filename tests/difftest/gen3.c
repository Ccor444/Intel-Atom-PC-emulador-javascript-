// Instruções de STRING (MOVS/CMPS/SCAS/LODS/STOS) com/sem REP/REPNE, DF=0/1, no hardware real.
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
typedef struct { uint64_t r[7]; uint64_t fl; } St;
void native_run(St *in, St *out, void *code);
typedef struct { uint16_t op, pfx, w16, df, cx, ax, fin, fout, cxo, axo, dsi, ddi, pad[4]; uint8_t src[64], dst[64], dsto[64]; } Rec;
int main(int argc, char **argv) {
  FILE *out = fopen(argv[1], "wb"); long N = atol(argv[2]); srand(4242);
  uint8_t *buf = mmap(0, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  static const uint8_t OPS[5] = {0xA4, 0xA6, 0xAE, 0xAC, 0xAA};   // movs cmps scas lods stos (byte; +1 = word)
  for (long n = 0; n < N; n++) {
    Rec r; memset(&r, 0, sizeof r); int k = rand() % 5, w16 = rand() & 1, pfx = rand() % 3;   // 0 nenhum, 1 REP(F3), 2 REPNE(F2)
    int df = rand() & 1, cx = rand() % 14; if (rand() % 6 == 0) cx = 0;
    for (int i = 0; i < 64; i++) r.src[i] = rand() % 4 ? rand() & 7 : rand();      // poucos valores distintos => muitas igualdades
    memcpy(r.dst, r.src, 64); int m = rand() % 3; if (m == 1) r.dst[16 + rand() % 24] ^= 1 + rand() % 255;      // às vezes idênticos, às vezes 1 diferença
    else if (m == 2) for (int i = 0; i < 64; i++) r.dst[i] = rand() & 7;
    if (k == 2) { for (int i = 0; i < 64; i++) r.dst[i] = rand() % 3 ? 5 : rand() & 7; }
    uint16_t ax = (rand() % 2) ? 5 | (5 << 8) : rand();
    uint8_t wsrc[64], wdst[64]; memcpy(wsrc, r.src, 64); memcpy(wdst, r.dst, 64);
    St in, o; memset(&in, 0, sizeof in); in.r[0] = ax; in.r[1] = cx; in.r[5] = (uint64_t)(wsrc + 32); in.r[6] = (uint64_t)(wdst + 32);
    uint16_t fin = 2 | (rand() & 0x8D5) | (df ? 0x400 : 0); in.fl = fin;
    int p = 0; if (pfx) buf[p++] = pfx == 1 ? 0xF3 : 0xF2; if (w16) buf[p++] = 0x66; buf[p++] = OPS[k] + w16; buf[p++] = 0xC3;
    native_run(&in, &o, buf);
    r.op = OPS[k]; r.pfx = pfx; r.w16 = w16; r.df = df; r.cx = cx; r.ax = ax; r.fin = fin & ~0x400; r.fout = (uint16_t)(o.fl & 0x8D5); r.cxo = (uint16_t)o.r[1]; r.axo = (uint16_t)o.r[0];
    r.dsi = (uint16_t)(o.r[5] - (uint64_t)(wsrc + 32)); r.ddi = (uint16_t)(o.r[6] - (uint64_t)(wdst + 32)); memcpy(r.dsto, wdst, 64);
    fwrite(&r, sizeof r, 1, out);
  }
  fclose(out); fprintf(stderr, "%ld vetores\n", N); return 0; }
