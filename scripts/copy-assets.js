// tsc only emits .js; the renderer's html/css need copying alongside it.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'renderer');
const dst = path.join(__dirname, '..', 'dist', 'renderer');
fs.mkdirSync(dst, { recursive: true });

let n = 0;
for (const f of fs.readdirSync(src)) {
  if (f.endsWith('.ts')) continue;
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  n++;
}
console.log(`copied ${n} renderer asset(s) -> dist/renderer`);
