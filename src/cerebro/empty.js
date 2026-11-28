// Empty folders become "- [ ] apagar:" items in <vault>/Triagem/Pastas vazias.md. Nothing is deleted
// here: the person ticks the lines and `guardian cerebro limpar --confirmar` sends them to the Recycle Bin.
// Ticks survive re-renders; lines already handled ("na Lixeira") are dropped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const norm = (p) => String(p).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
const LINE = /^\s*-\s*\[([ xX])\]\s*apagar:\s*`([^`]+)`/;

export function writeEmptyFolders({ file, projects, summaries }) {
  const ticked = new Set();
  if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split(/\r?\n/)) { const m = LINE.exec(l); if (m && m[1].toLowerCase() === 'x') ticked.add(norm(m[2])); }
  const targets = [];
  for (const p of projects) {
    const s = summaries[norm(p.root_path)];
    if (!s) continue;
    if (s.total === 0) { targets.push({ path: p.root_path, why: `projeto ${p.name} sem nenhum arquivo` }); continue; }
    for (const d of s.emptyDirs || []) targets.push({ path: path.join(p.root_path, d), why: `pasta vazia dentro de ${p.name}` });
  }
  const lines = ['# Pastas vazias', '', '_Pastas sem nenhum arquivo. Marque as que podem ir para a Lixeira e rode `guardian cerebro limpar` (mostra) e `guardian cerebro limpar --confirmar` (apaga)._', ''];
  for (const t of targets) lines.push(`- [${ticked.has(norm(t.path)) ? 'x' : ' '}] apagar: \`${t.path}\` — ${t.why}`);
  if (!targets.length) lines.push('- nenhuma');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
  return targets.length;
}
