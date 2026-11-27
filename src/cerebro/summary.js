import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const INBOX_DIR = 'Caixa de entrada';
export function safeName(name) { return String(name).replace(/[<>:"/\\|?*\u0000-\u001f#^[\]]/g, '-').trim() || 'sem-nome'; }

export function readInbox(vaultPath, projectName) {
  const file = path.join(vaultPath, INBOX_DIR, `${safeName(projectName)}.md`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  return text.length > 4096 ? text.slice(-4096) : text;
}

// Last non-empty paragraph of the inbox: agents append, newest last.
function latestInboxEntry(inbox) {
  if (!inbox) return null;
  const parts = inbox.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1].replace(/\s+/g, ' ') : null;
}

const KIND_LABEL = { code: 'código', music: 'música', video: 'vídeo', design: 'design', docs: 'documentos', media: 'mídia', other: 'pasta' };
export function kindLabel(kind) { return KIND_LABEL[kind] || 'pasta'; }

export function buildUniversalSummary({ project, intelligence = null, lastSession = null, inbox = null }) {
  const lines = [];
  lines.push(`**O que é:** ${project.name} (${kindLabel(project.kind)})`);
  const stopped = latestInboxEntry(inbox)
    || (lastSession?.last_message ? `${lastSession.last_message}` : null)
    || (intelligence?.current_focus?.value && intelligence.current_focus.value !== 'UNKNOWN' ? intelligence.current_focus.value : null);
  if (stopped) lines.push(`**Onde parou:** ${stopped}`);
  const next = intelligence?.next_steps?.[0]?.text;
  if (next) lines.push(`**Próximo passo:** ${next}`);
  return lines;
}

export function lastActivityIso(project, sessions = []) {
  const candidates = [project.latest_entry?.mtime, project.last_git_activity, project.last_file_activity, sessions[0]?.updated_at].filter(Boolean);
  if (!candidates.length) return null;
  return candidates.map((c) => new Date(c)).filter((d) => !Number.isNaN(d.getTime())).sort((a, b) => b - a)[0]?.toISOString() || null;
}

export function daysSince(iso, nowMs) { return iso ? (nowMs - new Date(iso).getTime()) / 86400000 : Infinity; }
export function isArchived(iso, nowMs, archiveDays = 365) { return daysSince(iso, nowMs) > archiveDays; }
