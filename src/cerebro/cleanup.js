import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  const ps = 'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CEREBRO_TARGET, \'OnlyErrorDialogs\', \'SendToRecycleBin\')';
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
