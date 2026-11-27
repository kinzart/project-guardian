import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const norm = (p) => String(p).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');

// Why a marked project must NOT be sent to the Recycle Bin, or null when it is safe.
export function refusalReason(project, { roots = [], projects = [], markedIds = new Set() } = {}) {
  const p = norm(project.root_path);
  if (/^[a-z]:$/.test(p) || p === '') return 'é a raiz de um disco';
  if (!/^[a-z]:\/./.test(p) && !p.startsWith('/')) return 'caminho não é absoluto';
  if (roots.some((r) => norm(r) === p)) return 'é uma das pastas varridas inteiras';
  if (roots.some((r) => norm(r).startsWith(`${p}/`))) return 'contém uma pasta varrida inteira';
  const inside = projects.filter((q) => q.id !== project.id && norm(q.root_path).startsWith(`${p}/`) && !markedIds.has(q.id));
  if (inside.length) return `tem outros projetos dentro que não foram marcados: ${inside.slice(0, 3).map((q) => q.name).join(', ')}`;
  return null;
}

// Sends a folder to the Windows Recycle Bin (Google Drive folders go to the Drive trash).
export function sendToRecycleBin(folder, { spawnImpl = spawnSync, platform = os.platform() } = {}) {
  if (platform !== 'win32') return { ok: false, error: 'só funciona no Windows' };
  if (!existsSync(folder)) return { ok: false, error: 'pasta não existe mais' };
  const method = statSync(folder).isDirectory() ? 'DeleteDirectory' : 'DeleteFile';
  const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}($env:CEREBRO_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  const r = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, CEREBRO_TARGET: folder }, encoding: 'utf8', windowsHide: true });
  if (r.status === 0 && !existsSync(folder)) return { ok: true };
  return { ok: false, error: (r.stderr || r.error?.message || `saída ${r.status}`).toString().trim().slice(0, 300) };
}

// Plan + optional execution. Returns [{ project, action: 'lixeira'|'recusado'|'erro'|'pendente', reason? }].
export function cleanup(marked, { roots, projects, confirm = false, recycle = sendToRecycleBin } = {}) {
  const markedIds = new Set(marked.map((p) => p.id));
  return marked.map((project) => {
    const reason = refusalReason(project, { roots, projects, markedIds });
    if (reason) return { project, action: 'recusado', reason };
    if (!confirm) return { project, action: 'pendente' };
    const r = recycle(project.root_path);
    return r.ok ? { project, action: 'lixeira' } : { project, action: 'erro', reason: r.error };
  });
}

const ITEM = /^(\s*-\s*\[)([xX])(\]\s*)apagar:(\s*`([^`]+)`.*)$/;

// Ticked "- [x] apagar: `path`" lines from the Triagem notes the AI wrote.
export function readTriageItems(triageDir) {
  const items = [];
  if (!existsSync(triageDir)) return items;
  for (const f of readdirSync(triageDir)) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    const file = path.join(triageDir, f);
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      const m = ITEM.exec(line);
      if (m) items.push({ file, index, target: m[5].trim() });
    });
  }
  return items;
}

export function itemRefusal(target, { roots = [], vaultPath = null, projects = [], markedIds = new Set() } = {}) {
  const t = norm(target);
  if (!path.isAbsolute(target) && !/^[a-z]:\//.test(t)) return 'caminho não é absoluto';
  if (/^[a-z]:$/.test(t) || t === '') return 'é a raiz de um disco';
  if (!roots.some((r) => t.startsWith(`${norm(r)}/`))) return 'fora das pastas varridas';
  if (vaultPath && (t === norm(vaultPath) || t.startsWith(`${norm(vaultPath)}/`))) return 'é o próprio cofre';
  const inside = projects.filter((q) => (norm(q.root_path) === t || norm(q.root_path).startsWith(`${t}/`)) && !markedIds.has(q.id));
  if (inside.length) return `contém o projeto ${inside[0].name}; para apagar um projeto inteiro use a caixinha excluir`;
  return null;
}

// Rewrites the ticked line so it is not processed twice.
export function markTriageDone(item, note) {
  const lines = readFileSync(item.file, 'utf8').split(/\r?\n/);
  const m = ITEM.exec(lines[item.index] || '');
  if (!m) return;
  lines[item.index] = `${m[1]}${m[2]}${m[3]}${note}:${m[4]}`;
  writeFileSync(item.file, lines.join('\n'));
}

export function cleanupTriage(items, { roots, vaultPath, projects, markedIds, confirm = false, recycle = sendToRecycleBin } = {}) {
  return items.map((item) => {
    const reason = itemRefusal(item.target, { roots, vaultPath, projects, markedIds });
    if (reason) return { item, action: 'recusado', reason };
    if (!confirm) return { item, action: 'pendente' };
    const r = recycle(item.target);
    if (r.ok) markTriageDone(item, 'na Lixeira');
    return r.ok ? { item, action: 'lixeira' } : { item, action: 'erro', reason: r.error };
  });
}
