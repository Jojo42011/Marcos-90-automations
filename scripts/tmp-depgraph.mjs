// throwaway: build the src/ import graph so removals can be reasoned about
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('src');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) files.push(p);
  }
})(ROOT);

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ''));
  const cands = [base + '.ts', path.join(base, 'index.ts')];
  for (const c of cands) if (fs.existsSync(c)) return path.relative(process.cwd(), c);
  return 'MISSING:' + path.relative(process.cwd(), base);
}

const imports = new Map();
const rev = new Map();
for (const f of files) {
  const rel = path.relative(process.cwd(), f);
  const src = fs.readFileSync(f, 'utf8');
  const specs = new Set();
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) specs.add(m[1]);
  const resolved = [...specs].map((s) => resolveSpec(f, s)).filter(Boolean);
  imports.set(rel, resolved);
  for (const r of resolved) {
    if (!rev.has(r)) rev.set(r, []);
    rev.get(r).push(rel);
  }
}

const mode = process.argv[2];
const arg = process.argv[3];
if (mode === 'rev') {
  // who imports anything matching arg (regex)
  const re = new RegExp(arg);
  const out = new Map();
  for (const [target, users] of rev) {
    if (!re.test(target)) continue;
    for (const u of users) {
      if (re.test(u)) continue; // internal to the removed set
      if (!out.has(u)) out.set(u, []);
      out.get(u).push(target);
    }
  }
  for (const [u, ts] of [...out].sort()) console.log(u + '\n    ' + ts.sort().join('\n    '));
} else if (mode === 'deps') {
  const re = new RegExp(arg);
  const out = new Set();
  for (const [f, ds] of imports) {
    if (!re.test(f)) continue;
    for (const d of ds) if (!re.test(d)) out.add(d);
  }
  for (const d of [...out].sort()) console.log(d);
} else if (mode === 'users') {
  console.log((rev.get(arg) || []).sort().join('\n'));
}
