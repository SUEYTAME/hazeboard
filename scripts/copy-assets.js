// tsc only emits .js; the renderer's html/css need copying alongside it.
//
// It also turns the renderer's modules into page-loadable scripts. tsc emits
// CommonJS, and ES modules are CORS-blocked over file://, which is how
// Electron loads these pages. A plain <script> tag would run each file in the
// shared global scope, where the `const types_1 = require(...)` that tsc emits
// in two files collides. So each module is wrapped in a function scope and
// registered with the tiny loader in the html, the way a bundler would.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'renderer');
const dist = path.join(root, 'dist');
const dst = path.join(dist, 'renderer');
fs.mkdirSync(dst, { recursive: true });

let n = 0;
for (const f of fs.readdirSync(src)) {
  if (f.endsWith('.ts')) continue;
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  n++;
}
console.log(`copied ${n} renderer asset(s) -> dist/renderer`);

/** Modules the pages load, keyed by the basename the html requires them as. */
const PAGE_MODULES = [
  'shared/types', 'shared/layout', 'shared/footer',
  'renderer/card', 'renderer/board', 'renderer/overlay',
];

let w = 0;
for (const mod of PAGE_MODULES) {
  const name = path.basename(mod);
  const from = path.join(dist, `${mod}.js`);
  if (!fs.existsSync(from)) throw new Error(`copy-assets: ${from} is missing - did tsc run?`);
  const code = fs.readFileSync(from, 'utf8');
  if (code.startsWith('__define(')) continue; // already wrapped (re-run)
  const wrapped =
    `__define(${JSON.stringify(name)}, function (require, exports, module) {\n${code}\n});\n`;
  // Shared modules stay CommonJS in dist/shared for the main process; the
  // page gets its own wrapped copy next to the html.
  fs.writeFileSync(path.join(dst, `${name}.js`), wrapped, 'utf8');
  w++;
}
console.log(`wrapped ${w} page module(s) -> dist/renderer`);
