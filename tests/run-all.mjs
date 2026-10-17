// node tests/run-all.mjs   (rode da RAIZ do projeto)  —  roda todos os testes e mostra um resumo.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const ROM = 'roms/GLABIOS_0.4.2_8P.ROM';
const suites = [
  ['CPU: JMP/CALL FAR indiretos', 'ctrl-flow-test.mjs'],
  ['PIT 8254 + boot da GLaBIOS', 'test-pit.mjs', ROM],
  ['INT 13h (2880 setores)', 'int13-test.mjs'],
  ['Boot FAT12 estilo FreeDOS', 'fat12-boot-test.mjs', ROM],
  ['COM1 / LPT1', 'peripherals-test.mjs', ROM],
  ['XMS / VDS / INT 15h', 'xms-test.mjs', ROM],
  ['CD-ROM ATAPI / ISO', 'test-cdrom.mjs'],
  ['Autoload (ISO + disco)', 'autoload-test.mjs', 'ok'],
  ['Autoload sem imagens', 'autoload-test.mjs', '404'],
  ['Autoload com ROM Z80 (recusa)', 'autoload-test.mjs', 'msx'],
  ['Controlador de disquete µPD765', 'fdc-test.mjs'],
  ['Boot real: disco pela ROM + µPD765', 'boot-real-check.mjs'],
  ['Página: POWER → FreeDOS A:\\>', 'e2e-page.mjs'],
  ['Teclado virtual (mobile)', 'vkeyboard-test.mjs'],
  ['Estabilidade (resets + 20 s)', 'soak.mjs'],
];
let bad = 0;
for (const [name, file, ...args] of suites) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join('tests', file), ...args], { cwd: root, encoding: 'utf8', timeout: 280000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const passed = (out.match(/✔/g) || []).length, failed = /✘/.test(out) || (r.status !== 0 && r.status !== null) || r.status === null || /Error: Cannot find module/.test(out);
  console.log(`${failed ? '✘' : '✔'} ${name.padEnd(32)} ${failed ? 'FALHOU' : `ok (${passed} verificações)`}  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (failed) { bad++; console.log(out.split('\n').filter((l) => /✘|Error/.test(l)).slice(0, 4).map((l) => '    ' + l).join('\n')); }
}
console.log(bad ? `\n✘ ${bad} suíte(s) com falha` : '\n✔ todas as suítes passaram'); process.exit(bad ? 1 : 0);
