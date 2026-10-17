// node dos-cmd.mjs "cmd1" "cmd2" ...  — boot real (ISO inserida), pula o instalador e digita comandos no DOS.
import fs from 'node:fs';
import { Motherboard } from '../src/motherboard.js';
import { loadCdFromFile } from '../src/cdrom.js';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const cmds = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const mb = new Motherboard({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }, { ramMB: 16, hddMB: 4 });
mb.setBIOSBinary(new Uint8Array(fs.readFileSync('roms/GLABIOS_0.4.2_8P.ROM')));
const IMGB = new Uint8Array(fs.readFileSync('disks/FD14BOOT.img'));
if (process.argv.includes('--no-setup')) {      // só em memória: troca "CALL SETUP.BAT floppy" por um REM do mesmo tamanho
  const pat = Buffer.from('CALL SETUP.BAT floppy'), rep = Buffer.from('REM  SETUP.BAT floppy'); const buf = Buffer.from(IMGB.buffer, IMGB.byteOffset, IMGB.length); let n = 0, i = -1;
  while ((i = buf.indexOf(pat, i + 1)) >= 0) { rep.copy(buf, i); n++; } console.error(`[no-setup] ${n} ocorrência(s) trocada(s) em memória`); }
mb.loadDiskImage(0, IMGB);
if (!process.argv.includes('--no-iso')) mb.loadCdImage(await loadCdFromFile(await fs.openAsBlob('disks/FD14LIVE.iso')));
const CP = (c) => c >= 32 && c < 127 ? String.fromCharCode(c) : c === 0 ? ' ' : (c >= 0xB0 && c <= 0xDF) ? '#' : '·';
const shot = () => { const o = []; for (let y = 0; y < 25; y++) { let s = ''; for (let x = 0; x < 80; x++) s += CP(mb.mem.read8(0xB8000 + (y * 80 + x) * 2)); o.push(s.trimEnd()); } while (o.length && !o[o.length - 1]) o.pop(); return o.join('\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const press = async (code, shift = false) => { if (shift) mb.kbd.keyDown('ShiftLeft'); mb.kbd.keyDown(code); await sleep(110); mb.kbd.keyUp(code); if (shift) mb.kbd.keyUp('ShiftLeft'); await sleep(90); };
const typeText = async (t) => { for (const ch of t) { if (/[a-z]/i.test(ch)) await press('Key' + ch.toUpperCase()); else if (/[0-9]/.test(ch)) await press('Digit' + ch);
  else if (ch === ' ') await press('Space'); else if (ch === ':') await press('Semicolon', true); else if (ch === '\\') await press('Backslash'); else if (ch === '.') await press('Period');
  else if (ch === '/') await press('Slash'); else if (ch === '-') await press('Minus'); else if (ch === '*') await press('Digit8', true); else if (ch === '\n') await press('Enter'); } };
const L = console.log; console.log = () => {}; console.warn = () => {};
const hx = (v, w = 4) => v.toString(16).padStart(w, '0'); const ring = []; let dumped = false; const c = mb.cpu; const origStep = c.step.bind(c);
c.step = () => { const cs = c.sregs[1], ip = c.ip; const b = []; for (let i = 0; i < 4; i++) b.push(hx(mb.mem.read8(((cs << 4) + ip + i) & 0xFFFFF), 2));
  ring.push(`${hx(cs)}:${hx(ip)} [${b.join(' ')}] AX=${hx(c.r16(0))} BX=${hx(c.r16(3))} CX=${hx(c.r16(1))} DX=${hx(c.r16(2))} SI=${hx(c.r16(6))} DI=${hx(c.r16(7))} SP=${hx(c.r16(4))} SS=${hx(c.sregs[2])} DS=${hx(c.sregs[3])} ES=${hx(c.sregs[0])}`); if (ring.length > 80) ring.shift(); return origStep(); };
console.error = (...a) => { if (!dumped && String(a[0]).includes('[CPU]')) { dumped = true; L('\n!!! ERRO DE CPU:', a.join(' ')); L(ring.slice(-8).join('\n')); try { const seg = 0x1138; const buf = Buffer.alloc(0x700); for (let i = 0; i < buf.length; i++) buf[i] = mb.mem.read8((seg << 4) + i); fs.writeFileSync('/tmp/lbacache.bin', buf); } catch (e) {} } };
mb.powerOn(); await sleep(12000);
for (let i = 0; i < 14 && !/A:\\>/.test(shot()); i++) { const f = /\(F\)ail\?/.test(shot()); await press(f ? 'KeyF' : 'Enter'); await sleep(3200); if (process.argv.includes('--trace')) L(`-- passo ${i} (${f ? 'F' : 'Enter'}) | ${shot().split('\n').slice(-3).join(' // ').slice(0, 150)}`); }
await sleep(1500); const atPrompt = /A:\\>/.test(shot()); L(atPrompt ? '[ok] prompt A:\\> alcançado' : '[!] prompt não apareceu; tela atual abaixo'); if (!atPrompt) L(shot());
for (const c of cmds) { await typeText(c + '\n'); await sleep(4500); L(`\n===== depois de "${c}" =====\n${shot().split('\n').slice(-16).join('\n')}`); }
mb.powerOff(); console.log = L; L(`\nCPU erros=${mb._loopErrors} IP=${mb.loopStatus().ip}`);
