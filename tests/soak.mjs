import { Motherboard } from '../src/motherboard.js';
import fs from 'node:fs';
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const cv = { getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) };
const mb = new Motherboard(cv, { ramMB: 16, hddMB: 4 });
mb.setBIOSBinary(new Uint8Array(fs.readFileSync('roms/GLABIOS_0.4.2_8P.ROM')));
const buf = new Uint8Array(512); let i = 0; const e = (...b) => { for (const x of b) buf[i++] = x; };
e(0xFA,0x31,0xC0,0x8E,0xD8,0x8E,0xC0,0x8E,0xD0,0xBC,0x00,0x7C,0xBE,0x1D,0x7C,0xB4,0x0E,0xAC,0x84,0xC0,0x74,0x04,0xCD,0x10,0xEB,0xF7,0xF4,0xEB,0xFD);
for (const ch of "Hello from Intel Atom PC!\r\nBoot OK - Halted.\r\n\0") e(ch.charCodeAt(0));
buf[510]=0x55; buf[511]=0xAA; mb.loadDiskImage(0, buf);
const oc = console.log; console.log = () => {};
const txt = () => { let o=''; for (let y=0;y<25;y++){ let l=''; for(let x=0;x<80;x++){ const c=mb.mem.read8(0xB8000+(y*80+x)*2); l+= c>=32&&c<127?String.fromCharCode(c):' ';} o+=l.trimEnd()+'\n'; } return o; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
mb.powerOn(); await sleep(2500);
oc('1º boot  :', txt().includes('Boot OK - Halted.') ? 'OK (MBR rodou)' : 'FALHOU');
// Reset a quente 3x
for (let k = 1; k <= 3; k++) {
  mb.reset(); await sleep(2500);
  oc(`reset #${k}:`, txt().includes('RAM    [ 640 KB OK ]') && txt().includes('Boot OK - Halted.') ? 'OK' : 'FALHOU', ' erros=', mb._loopErrors);
}
// soak 20 s com tecla pressionada de vez em quando
const c0 = mb.cycleCount, t0 = performance.now();
for (let s = 0; s < 10; s++) { mb.kbd.keyDown('KeyA'); await sleep(50); mb.kbd.keyUp('KeyA'); await sleep(1950); }
oc(`soak 20 s: erros=${mb._loopErrors}  ${((mb.cycleCount - c0) / (performance.now() - t0) / 1000).toFixed(1)} MIPS  halted=${mb.cpu.halted}  tela ainda ok=${txt().includes('Boot OK - Halted.')}`);
mb.powerOff(); process.exit(0);
