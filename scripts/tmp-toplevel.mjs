// throwaway: list top-level statements of a big TS file with line ranges
import fs from 'node:fs';

const file = process.argv[2];
const lo = Number(process.argv[3] || 1);
const hi = Number(process.argv[4] || 1e9);
const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');

let depth = 0;
let inBlockComment = false;
let inTemplate = false;
let start = null;
const stmts = [];
let prevSignificant = '';

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (depth === 0 && !inBlockComment && !inTemplate && start === null && line.trim() !== '') start = i;
  let j = 0;
  while (j < line.length) {
    const c = line[j];
    const n = line[j + 1];
    if (!inBlockComment && !inTemplate && c === '/' && n !== '/' && n !== '*' && /[=(,:[!&|?{};+]|^$/.test(prevSignificant)) {
      // regex literal: skip to the unescaped closing slash on this line
      let k = j + 1;
      let inClass = false;
      let closed = false;
      while (k < line.length) {
        if (line[k] === '\\') { k += 2; continue; }
        if (line[k] === '[') inClass = true;
        else if (line[k] === ']') inClass = false;
        else if (line[k] === '/' && !inClass) { closed = true; k++; break; }
        k++;
      }
      if (closed) { j = k; prevSignificant = '/'; continue; }
    }
    if (inBlockComment) {
      if (c === '*' && n === '/') { inBlockComment = false; j += 2; continue; }
      j++; continue;
    }
    if (inTemplate) {
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { inTemplate = false; j++; continue; }
      j++; continue;
    }
    if (c === '/' && n === '*') { inBlockComment = true; j += 2; continue; }
    if (c === '/' && n === '/') break;
    if (c === '`') { inTemplate = true; j++; continue; }
    if (c === '"' || c === "'") {
      const q = c; j++;
      while (j < line.length) { if (line[j] === '\\') { j += 2; continue; } if (line[j] === q) { j++; break; } j++; }
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (!/\s/.test(c)) prevSignificant = c;
    j++;
  }
  if (depth === 0 && !inBlockComment && !inTemplate && start !== null) {
    const t = lines[i].trim();
    if (t === '' ) continue;
    if (/[;}\)\]]\s*$/.test(t) || /^(import|export)\b.*from\s+["'].*["'];?$/.test(t) || /^\/\//.test(t)) {
      stmts.push([start + 1, i + 1]);
      start = null;
    }
  }
}

for (const [a, b] of stmts) {
  if (b < lo || a > hi) continue;
  let head = '';
  for (let k = a - 1; k < b; k++) {
    const t = lines[k].trim();
    if (t && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*')) { head = t; break; }
  }
  console.log(`${a}-${b}\t${head.slice(0, 120)}`);
}
