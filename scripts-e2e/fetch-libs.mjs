// Downloads (does NOT install) the shared libraries Playwright's browsers need
// into ./.e2e-env, for machines where you can't `apt install` them.
// Usage: node scripts-e2e/fetch-libs.mjs <browser...>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve('.e2e-env');
const MIRROR = 'http://archive.ubuntu.com/ubuntu/';
const { deps } = require(path.resolve('node_modules/playwright-core/lib/server/registry/nativeDeps.js'));
const want = process.argv.slice(2);
const platform = deps['ubuntu22.04-x64'];

// Fetch and parse the package indexes; later (updates) entries win.
const INDEXES = ['jammy-main', 'jammy-universe', 'jammy-updates-main', 'jammy-updates-universe'];
fs.mkdirSync(path.join(ROOT, 'index'), { recursive: true });
for (const f of INDEXES) {
  const out = path.join(ROOT, 'index', `${f}.gz`);
  const [suite, comp] = [f.slice(0, f.lastIndexOf('-')), f.slice(f.lastIndexOf('-') + 1)];
  if (!fs.existsSync(out)) execFileSync('curl', ['-sf', '--max-time', '300', '-o', out, `${MIRROR}dists/${suite}/${comp}/binary-amd64/Packages.gz`]);
}
const pkgs = new Map();
for (const f of INDEXES) {
  const text = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'index', `${f}.gz`))).toString();
  for (const block of text.split('\n\n')) {
    const get = (k) => (block.match(new RegExp(`^${k}: (.*)$`, 'm')) || [])[1];
    const name = get('Package');
    if (!name) continue;
    const provides = (get('Provides') || '').split(',').map((s) => s.trim().split(' ')[0]).filter(Boolean);
    const p = { name, file: get('Filename'), depends: get('Pre-Depends') ? `${get('Pre-Depends')}, ${get('Depends') || ''}` : get('Depends') || '' };
    pkgs.set(name, p);
    for (const v of provides) if (!pkgs.has(v)) pkgs.set(v, p);
  }
}

// Packages already on this machine (no need to fetch them).
const installed = new Set(
  execFileSync('dpkg-query', ['-W', '-f=${Package}\\n']).toString().split('\n').map((s) => s.split(':')[0])
);

const roots = [...new Set([...want.flatMap((b) => platform[b] || []), 'fonts-dejavu-core', 'fontconfig-config'])];
const seen = new Set();
const queue = [...roots];
const fetch = [];
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name) || installed.has(name)) continue;
  seen.add(name);
  const p = pkgs.get(name);
  if (!p) {
    console.warn('not found:', name);
    continue;
  }
  if (p.name !== name && (seen.has(p.name) || installed.has(p.name))) continue;
  seen.add(p.name);
  fetch.push(p);
  for (const alt of p.depends.split(',')) {
    const opts = alt.split('|').map((s) => s.trim().split(/[ :(]/)[0]).filter(Boolean);
    if (!opts.length || opts.some((o) => installed.has(o) || seen.has(o))) continue;
    queue.push(opts.find((o) => pkgs.has(o)) || opts[0]);
  }
}

fs.mkdirSync(path.join(ROOT, 'debs'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'root'), { recursive: true });
for (const p of fetch) {
  const out = path.join(ROOT, 'debs', path.basename(p.file));
  if (!fs.existsSync(out)) execFileSync('curl', ['-sf', '--max-time', '120', '-o', out, MIRROR + p.file]);
  execFileSync('dpkg-deb', ['-x', out, path.join(ROOT, 'root')]);
}
// A fontconfig setup that only looks inside .e2e-env (machines without any
// fonts make Chromium hang on pages with text inputs).
fs.mkdirSync(path.join(ROOT, 'fontcache'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'fonts.conf'),
  `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${path.join(ROOT, 'root/usr/share/fonts')}</dir>
  <cachedir>${path.join(ROOT, 'fontcache')}</cachedir>
  <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>DejaVu Serif</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>DejaVu Sans Mono</family></prefer></alias>
</fontconfig>
`
);
console.log(`fetched ${fetch.length} packages`);
