# Intel Atom PC — emulador x86 (modo real) em JavaScript puro

Emulador de PC que roda no navegador, sem dependências: CPU x86 (~180 opcodes, ModRM/SIB), BIOS **GLaBIOS 0.4.2**
(PC/XT) real, VGA texto 80×25, teclado, PIT 8254, PIC 8259, DMA 8237, PPI 8255, disquete, IDE, **CD-ROM ATAPI com
ISO**, COM1, LPT1 e **XMS/VDS** em JS. Inicia o **FreeDOS 1.4** a partir do disquete `FD14BOOT.img` e enxerga a
ISO `FD14LIVE.iso` como drive `D:`.

## Teclado virtual (celular e tablet)

Botão **⌨ TECLADO** no painel mostra/esconde um teclado de layout US abaixo do monitor. Toque em Shift, Ctrl ou Alt
para travar o modificador; ele solta sozinho depois da próxima tecla (ou toque de novo para soltar sem digitar).
O teclado envia os mesmos códigos do teclado físico (`mb.kbd.keyDown/keyUp`).


## O que é emulação de verdade e o que não é

| Parte | Como funciona |
|---|---|
| CPU x86 (8/16/32 bits, memória, strings) | Emulada; conferida instrução a instrução contra o hardware real (`tests/difftest`) |
| BIOS GLaBIOS | Código real da ROM rodando na CPU emulada |
| Disquete 1,44 MB (boot e leitura de arquivos) | **Real**: controlador NEC µPD765 (`src/fdc.js`) + DMA 8237 + IRQ6; a ROM faz READ DATA/SEEK/RECALIBRATE |
| Kernel, shell e comandos do FreeDOS | Código real do FreeDOS executando (≈96% das instruções são do DOS) |
| Teclado, VGA texto, PIT, PIC, COM1, LPT1 | Emulados no nível de registrador/porta |
| CD-ROM (ISO) | ATAPI emulado; o drive `D:` aparece, mas `dir` em `D:\FREEDOS\BIN` ainda falha |
| **XMS 3.0 / VDS / INT 15h estendido** | **Atendidos em JavaScript** (`src/xms.js`): o HimemX real exige modo protegido, que não existe aqui |
| **Disco rígido (INT 13h para C:)** | **Atendido em JavaScript** quando não há disquete: a GLaBIOS usa o controlador XT (WD1002, 0x320), ainda não emulado |

Para medir isso: `node tests/boot-real-check.mjs` mostra quantas instruções rodam na ROM, quantos serviços são
atendidos em JavaScript e quantos comandos chegam ao µPD765.

## Instalador do FreeDOS

O `FD14BOOT.img` chama `SETUP.BAT` no boot. O instalador pede o disco RAM `V:`, cujo driver ainda não funciona. Por isso a página
troca essa chamada por um `REM` **só na memória** (chave `SKIP_SETUP` em `src/main.js`; `false` mostra o instalador de novo).
O arquivo `disks/FD14BOOT.img` não é alterado.

## Como rodar

1. O disquete `disks/FD14BOOT.img` e a ROM já estão no ZIP. O FreeDOS roda a partir do disquete.
   (Para testar o CD, copie `FD14LIVE.iso` para `disks/` e use o seletor "Imagem de CD" do painel; o pré-carregamento
   automático está desligado porque o CD ainda não é confiável.)
2. Sirva a pasta por HTTP (abrir o `index.html` direto, `file://`, não funciona):
   - `python -m http.server 8000` (no Windows: `py -m http.server 8000`) e abra `http://localhost:8000`
   - ou a extensão **Live Server** do VS Code, ou qualquer servidor estático no celular.
3. Clique em **POWER**. Quando o FreeDOS pedir uma tecla (`   >`), pressione Enter para chegar ao prompt `A:\>`.

O painel mostra BIOS, Disco A: e CD-ROM carregados. Quer outra imagem? Use os seletores do painel e clique em **RESET**.
Para ligar o pré-carregamento da ISO: `const ISO_PATH = 'disks/FD14LIVE.iso';` em `src/main.js`.

## Estrutura

```
index.html  style.css
src/
  cpu.js          CPU x86: registradores, flags, opcodes, A20, INT/IRET
  motherboard.js  integra tudo, roteamento de I/O, INT 13h (disquete), IRQs, loop principal
  devices.js      VGA (CP437), teclado, IDE, PIC, PIT, DMA, PPI, UART 16550A (COM1), LPT1
  cdrom.js        canal IDE secundário com CD-ROM ATAPI e carregador de ISO (streaming)
  xms.js          XMS 3.0 + VDS + INT 15h estendido em JS (o CD precisa de XMS)
  bios.js         carga da ROM e handlers do stub interno
  chipset.js      memória e fonte ATX
  main.js         inicialização, pré-carga de disco/ISO, validação da ROM, painel
roms/   GLABIOS_0.4.2_8P.ROM         (BIOS x86; ROMs de MSX/Z80 são recusadas)
disks/  FD14BOOT.img  (+ FD14LIVE.iso, que você copia)
tests/  testes automatizados (Node 18+): npm test
tools/  ferramentas de depuração (Node)
```

## Testes (opcional, precisa de Node 18+)

```
npm test                         # roda todas as suítes (tests/run-all.mjs)
node tests/xms-test.mjs roms/GLABIOS_0.4.2_8P.ROM
```
`tests/difftest/` compara a CPU com o **hardware real** (gcc necessário, x86-64): veja os comentários em `gen*.c`
e `run*.mjs` (gere os vetores com `gen`, depois `node tests/difftest/run.mjs vetores.bin`).

## Ferramentas (Node)

```
node tools/boot-sistema.mjs                   # liga o PC e espera o prompt A:\>
node tools/dos-prompt.mjs "ver" "dir" "mem"    # digita comandos no prompt
node tools/boot-real.mjs 12 [--iso]            # boot real e relatório (tela, INT 13h, IPs)
node tools/snap.mjs 40 --iso --keys=ENTER      # fotos da tela ao longo do tempo
node tools/dos-cmd.mjs --no-setup "d:" "dir"   # pula o instalador e digita comandos no DOS
```

## Situação atual

Funciona: boot da GLaBIOS, FreeDOS 1.4 até o prompt `A:\>` (a partir do disquete), comandos `ver`, `dir`, `mem`,
FAT12, INT 13h, XMS (LBACACHE, FreeCom XMS_Swap), COM1/LPT1, teclado.

Parcial: CD-ROM aparece como `D:` (ISO real), mas `dir` em `D:\FREEDOS\BIN` falha (LBA inválido no driver de cache).

Ainda não: o instalador completo do FreeDOS (pede um disco RAM `V:` e dá *write-protection violation*), boot direto
pela ISO (El Torito), controlador de disquete (a BIOS mostra `FDD [ 0 ]`), HMA/UMB, modo protegido.

## Licenças

GLaBIOS: GPLv3 (640KB). FreeDOS: GPL e licenças dos respectivos pacotes. O código do emulador é do autor do projeto.
