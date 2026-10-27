// Builds GG World into gg-app/public/world/ (index.html + game.js): one classic IIFE script, every asset inlined,
// so it runs inside the app with no network and no extra CSP sources.
//   node packages/gg-world/build.mjs           build
//   node packages/gg-world/build.mjs --if-stale build only when src/ changed since the last build (fast app dev starts)
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../gg-app/public/world');
const stampFile = path.join(outDir, '.build-stamp');

function hashSrc() {
  const h = crypto.createHash('sha256');
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else { h.update(p.slice(here.length)); h.update(fs.readFileSync(p)); } } };
  walk(path.join(here, 'src')); h.update(fs.readFileSync(path.join(here, 'index.html'))); h.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  return h.digest('hex');
}

const stamp = hashSrc();
if (process.argv.includes('--if-stale') && fs.existsSync(path.join(outDir, 'game.js')) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp) {
  console.log('gg-world: up to date');
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [path.join(here, 'src/main.js')], bundle: true, minify: true, format: 'iife', target: 'es2020', legalComments: 'none',
  outfile: path.join(outDir, 'game.js'), logLevel: 'warning',
  // World runs sealed (no localStorage of its own): every storage use goes through boot.js's store
  define: { localStorage: 'globalThis.__ggStore', 'window.localStorage': 'globalThis.__ggStore', sessionStorage: 'globalThis.__ggSession', 'window.sessionStorage': 'globalThis.__ggSession' },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl', '.glb': 'binary', '.woff2': 'dataurl', '.ttf': 'dataurl', '.mp3': 'dataurl', '.ogg': 'dataurl' },
});
await build({ entryPoints: [path.join(here, 'src/boot.js')], bundle: false, minify: true, format: 'iife', target: 'es2020', legalComments: 'none', outfile: path.join(outDir, 'boot.js'), logLevel: 'warning' });
fs.copyFileSync(path.join(here, 'index.html'), path.join(outDir, 'index.html'));
fs.writeFileSync(stampFile, stamp);
console.log(`gg-world: built gg-app/public/world/game.js ${(fs.statSync(path.join(outDir, 'game.js')).size / 1024).toFixed(0)} KB`);
