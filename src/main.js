'use strict';

import { Motherboard } from './motherboard.js';
import { createVirtualKeyboard } from './vkeyboard.js';
import { loadCdFromFile, loadCdFromURL } from './cdrom.js';

const canvas = document.getElementById('screen');
const mb = new Motherboard(canvas, { ramMB: 16, hddMB: 4 });

// Expõe a Motherboard globalmente para debug no console (F12)
window.mb = mb;

// Teclado virtual: botão ⌨ TECLADO no painel mostra/esconde o teclado (layout US) abaixo do monitor.
{
  const vkb = createVirtualKeyboard(mb, document.getElementById('vkb'));
  const btn = document.getElementById('btn-kbd');
  const sync = () => btn.classList.toggle('active', vkb.isVisible());
  btn.onclick = () => { vkb.toggle(); sync(); };
  sync();
  window.vkb = vkb;                       // para depuração no console
}

// Diagnóstico: qualquer erro não tratado aparece com arquivo:linha e stack no console.
window.addEventListener('error', (ev) => {
  console.error('[ERRO]', ev.message, `${ev.filename}:${ev.lineno}:${ev.colno}`, ev.error && ev.error.stack);
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('[ERRO-PROMISE]', ev.reason && ev.reason.message, ev.reason && ev.reason.stack);
});

// Atualiza o painel de status do index.html (ignora se o elemento não existir)
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ============================================================
// MBR de exemplo (usado se nenhuma imagem for carregada)
// ============================================================
function buildHelloMBR() {
  const buf = new Uint8Array(512);
  let i = 0;
  const emit = (...b) => { for (const x of b) buf[i++] = x; };

  emit(0xFA);                // cli
  emit(0x31, 0xC0);          // xor ax, ax
  emit(0x8E, 0xD8);          // mov ds, ax
  emit(0x8E, 0xC0);          // mov es, ax
  emit(0x8E, 0xD0);          // mov ss, ax
  emit(0xBC, 0x00, 0x7C);    // mov sp, 0x7C00
  emit(0xBE, 0x1D, 0x7C);    // mov si, 0x7C1D
  emit(0xB4, 0x0E);          // mov ah, 0x0E
  emit(0xAC);                // loop: lodsb
  emit(0x84, 0xC0);          // test al, al
  emit(0x74, 0x04);          // jz done
  emit(0xCD, 0x10);          // int 0x10
  emit(0xEB, 0xF7);          // jmp loop
  emit(0xF4);                // done: hlt
  emit(0xEB, 0xFD);          // jmp done

  const msg = "Hello from Intel Atom PC!\r\nBoot OK - Halted.\r\n\0";
  for (let j = 0; j < msg.length; j++) emit(msg.charCodeAt(j));

  while (i < 510) emit(0);
  emit(0x55, 0xAA);
  return buf;
}
mb.loadDiskImage(0, buildHelloMBR());

// ============================================================
// Carrega BIOS da pasta roms/ automaticamente
// ============================================================
/**
 * Uma BIOS de PC x86 tem um salto (normalmente JMP FAR, 0xEA) no vetor de reset, 16 bytes antes do fim da ROM.
 * ROMs de outras máquinas (ex.: MSX, que é Z80) não passam: executá-las só roda lixo.
 * @returns {string|null} motivo da recusa, ou null se parece uma BIOS x86
 */
function whyNotX86Bios(buf) {
  if (buf.length >= 2 && buf[0] === 0x41 && buf[1] === 0x42) return 'parece ROM de MSX (Z80), incompatível com x86';
  if (buf.length >= 3 && buf[0] === 0xF3 && buf[1] === 0xC3) return 'começa com DI; JP (código Z80, típico de MSX), incompatível com x86';
  if (buf.length < 16) return 'arquivo pequeno demais';
  const b = buf[buf.length - 16];
  if (b !== 0xEA && b !== 0xE9 && b !== 0xEB && b !== 0xFA)
    return `sem salto no vetor de reset (0x${b.toString(16).padStart(2, '0')}; BIOS x86 tem 0xEA)`;
  return null;
}

async function bootstrapBIOS() {
  let rejected = null;
  const candidates = [
    'roms/GLABIOS_0.4.2_8P.ROM',   // ← caminho exato do arquivo
    'roms/glabios.bin',            // fallback 1
    'roms/bios.bin',               // fallback 2
    'roms/seabios.bin',            // fallback 3 (não vai bootar, mas tenta)
  ];

  for (const path of candidates) {
    try {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) {
        console.warn(`[BIOS] Não encontrado: ${path} (HTTP ${res.status})`);
        continue;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const why = whyNotX86Bios(buf);
      if (why) {
        console.error(`[BIOS] ROM recusada: ${path} (${buf.length} bytes) — ${why}.`);
        rejected = `ROM recusada (${path.split('/').pop()}): ${why}`;
        continue;
      }
      mb.setBIOSBinary(buf);
      console.log(`[BIOS] Carregada: ${path} (${buf.length} bytes)`);
      setText('s-bios', `${path.split('/').pop()} (${buf.length} B)`);
      return true;
    } catch (err) {
      console.warn(`[BIOS] Falha ao carregar ${path}:`, err.message);
    }
  }

  console.warn('[BIOS] Nenhuma ROM x86 válida em roms/ — usando stub mínimo interno.');
  setText('s-bios', rejected ? `⚠ ${rejected} — usando stub interno` : 'stub interno (sem ROM em roms/)');
  return false;
}

// ============================================================
// Pré-carrega o disquete A: da pasta disks/ automaticamente
// ============================================================
// Se nenhuma imagem for encontrada, fica o MBR de exemplo (Hello) carregado acima.
const FLOPPY_BYTES = 1474560;   // 1,44 MB = 80 cil × 2 cab × 18 set × 512 (geometria do INT 13h)

// O FD14BOOT.img chama SETUP.BAT no boot (FDAUTO.BAT). O instalador pede o disco RAM V:, cujo driver ainda não
// funciona, e trava em "(A)bort, (I)gnore, (R)etry, (F)ail?". Com SKIP_SETUP, a linha é trocada por um REM de mesmo
// tamanho na memória, e o FreeDOS chega direto ao prompt A:\>. Desligue com SKIP_SETUP = false para ver o instalador.
const SKIP_SETUP = true;
function skipFreeDosInstaller(buf) {
  const pat = new TextEncoder().encode('CALL SETUP.BAT floppy');
  const rep = new TextEncoder().encode('REM  SETUP.BAT floppy');
  for (let i = 0; i + pat.length <= buf.length; i++) {
    let m = true;
    for (let j = 0; j < pat.length && m; j++) if (buf[i + j] !== pat[j]) m = false;
    if (m) buf.set(rep, i);
  }
}

async function bootstrapDisk() {
  const candidates = [
    'disks/FD14BOOT.img',         // ← FreeDOS 1.4 boot floppy
  ];

  for (const path of candidates) {
    try {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) {
        console.warn(`[DISK] Não encontrado: ${path} (HTTP ${res.status})`);
        continue;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (SKIP_SETUP) skipFreeDosInstaller(buf);   // só na memória: o arquivo em disks/ não muda
      if (buf.length !== FLOPPY_BYTES) {
        console.warn(`[DISK] ${path} tem ${buf.length} bytes (esperado ${FLOPPY_BYTES}): ` +
                     'o INT 13h só entende disquete de 1,44 MB; outros formatos podem falhar.');
      }
      mb.loadDiskImage(0, buf);
      console.log(`[DISK] Carregado em A: ${path} (${buf.length} bytes)`);
      setText('s-disk', `${path.split('/').pop()} (${Math.round(buf.length / 1024)} KB)`);
      return true;
    } catch (err) {
      console.warn(`[DISK] Falha ao carregar ${path}:`, err.message);
    }
  }

  console.warn('[DISK] Nenhuma imagem em disks/ — usando o MBR de exemplo.');
  setText('s-disk', 'MBR de exemplo (sem imagem em disks/)');
  return false;
}

// ============================================================
// CD-ROM: pré-carrega disks/FD14LIVE.iso (se existir) ou usa o seletor de ISO
// ============================================================
// A ISO inteira vai para a RAM (300 MB é pouco). O botão Power espera o fim do carregamento (no máximo
// 3 min): o FreeDOS procura o drive e a mídia de CD logo no boot, e com o PC rodando a CPU disputaria
// o processador com o download. Inserindo uma ISO com o PC já ligado, dê RESET (o drive avisa "mídia trocada").
const ISO_PATH = null;   // pré-carregamento da ISO desligado por padrão (o CD ainda não é confiável); defina 'disks/FD14LIVE.iso' para ligar, ou use o seletor

function describeCD(cd) {
  const m = cd.bytes.length / 1048576, mbs = m < 10 ? m.toFixed(1) : m.toFixed(0);
  if (!cd.isIso9660) return `${cd.name} (${mbs} MB) — não parece ISO9660`;
  // rótulo do volume (PVD, setor 16, bytes 40-71) e boot record El Torito (setor 17)
  const label = String.fromCharCode(...cd.read(16).subarray(40, 72)).trim();
  const bt = String.fromCharCode(...cd.read(17).subarray(7, 30)) === 'EL TORITO SPECIFICATION';
  return `${cd.name} · ${mbs} MB · ${label || 'sem rótulo'} · ${bt ? 'boot El Torito' : 'sem boot El Torito'}`;
}

function insertCD(cd) {
  mb.loadCdImage(cd);                    // insere no drive ATAPI (IDE secundário)
  setText('s-cd', describeCD(cd));
  console.log(`[CD] ${describeCD(cd)}`);
}

const progress = (loaded, total) =>
  setText('s-cd', `carregando… ${Math.floor((loaded / total) * 100)}% (${(loaded / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB)`);

/**
 * Devtools de celular (eruda) trocam window.fetch para registrar o painel Network e tentam ler a
 * resposta INTEIRA como texto — com 302 MB isso estoura ("Invalid string length") e ainda duplica a
 * memória. O fetch de um iframe oculto vem do contexto original, sem esse hook.
 */
function cleanFetch() {
  try {
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    document.body.appendChild(frame);          // precisa continuar no DOM durante o download
    const f = frame.contentWindow.fetch;
    if (typeof f === 'function') return f.bind(frame.contentWindow);
  } catch (e) { /* sem iframe: usa o fetch normal */ }
  return globalThis.fetch.bind(globalThis);
}

async function bootstrapCD() {
  if (!ISO_PATH) { setText('s-cd', 'nenhum (use o seletor de ISO)'); return false; }   // painel sempre preenchido
  try {
    setText('s-cd', 'carregando…');
    const url = document.baseURI ? new URL(ISO_PATH, document.baseURI).href : ISO_PATH;   // absoluta: o iframe não herda a base
    insertCD(await loadCdFromURL(url, progress, cleanFetch()));
    return true;
  } catch (err) {
    console.warn(`[CD] Sem ISO em ${ISO_PATH} (${err.message}) — use o seletor de ISO.`);
    setText('s-cd', 'nenhum (use o seletor de ISO)');
    return false;
  }
}
const cdReady = bootstrapCD();           // o Power aguarda esta promessa (com limite de tempo)

// BIOS e disco são carregados em sequência; o botão de power espera os dois.
const ready = (async () => {
  await bootstrapBIOS();
  await bootstrapDisk();
})();

// ============================================================
// UI
// ============================================================
let powering = false;
document.getElementById('btn-power').onclick = async () => {
  if (mb.running) { mb.powerOff(); return; }
  if (powering) return;                          // clique repetido enquanto espera o carregamento
  powering = true;
  try {
    await ready;                                 // BIOS + disco
    await Promise.race([cdReady, new Promise((r) => setTimeout(r, 180000))]);   // ISO pré-carregada
    mb.powerOn();
  } finally { powering = false; }
};
document.getElementById('btn-reset').onclick = () => mb.reset();

mb.psu.onEvent((ev) => {
  document.getElementById('led-pwr').classList.toggle('on',
    ev === 'on' || ev === 'powergood');
});

mb.onDiskActivity = (active) => {
  document.getElementById('led-hdd').classList.toggle('on', active);
};

mb.bindInput(window);

// Seletor de ISO (lê o File por streaming, sem passar pelo servidor)
document.getElementById('iso-input').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    insertCD(await loadCdFromFile(f, progress));
  } catch (err) {
    console.error('[CD] Falha ao ler a ISO:', err);
    setText('s-cd', `erro: ${err.message}`);
  }
};

// Upload de imagem de disco
document.getElementById('disk-input').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const buf = new Uint8Array(await f.arrayBuffer());
  if (SKIP_SETUP && buf.length === 1474560) skipFreeDosInstaller(buf);   // mesma troca do carregamento automático
  mb.loadDiskImage(0, buf);
  console.log(`Disco: ${f.name} (${buf.length} bytes) — RESET para aplicar`);
  setText('s-disk', `${f.name} (manual, clique em RESET)`);
};

// Upload de BIOS (opcional)
const biosInput = document.getElementById('bios-input');
if (biosInput) {
  biosInput.onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    const why = whyNotX86Bios(buf);
    if (why) { alert(`ROM recusada: ${why}.`); setText('s-bios', `⚠ ${f.name} recusada: ${why}`); return; }
    try {
      mb.setBIOSBinary(buf);
      setText('s-bios', `${f.name} (${buf.length} B, manual — RESET para aplicar)`);
      console.log(`BIOS: ${f.name} (${buf.length} bytes) — RESET para aplicar`);
    } catch (err) {
      alert(`BIOS inválida: ${err.message}`);
    }
  };
}

// Stats
setInterval(() => {
  const now = performance.now();
  if (mb._lastFrame) {
    const dt = (now - mb._lastFrame) / 1000;
    const dc = mb.cycleCount - mb._lastCycles;
    mb.currentKHz = dc / dt / 1000;
  }
  mb._lastFrame = now;
  mb._lastCycles = mb.cycleCount;
  document.getElementById('s-cycles').textContent = mb.cycleCount.toLocaleString('pt-BR');
  document.getElementById('s-mips').textContent = mb.currentKHz.toFixed(1);
}, 500);

// ============================================================
// Bootstrap final
// ============================================================
ready.then(() => console.log('[MAIN] BIOS e disco prontos — clique em Power.'));