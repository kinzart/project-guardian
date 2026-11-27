import { statSync } from 'node:fs';
import path from 'node:path';
import { parseJson, readTailLines, trimSummary } from './tail.js';

function text(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x?.type === 'text' && x.text).map((x) => x.text).join('\n') || null;
  return null;
}

// One Claude Code transcript (~/.claude/projects/<slug>/<uuid>.jsonl) -> AgentSessionRecord.
export function readClaudeSession(file) {
  let sessionId = null; let cwd = null; let last = null; let ts = null; let title = null;
  for (const line of readTailLines(file)) {
    const o = parseJson(line);
    if (!o) continue;
    if (o.type === 'summary' && o.summary) title = o.summary;
    if (o.sessionId) sessionId = o.sessionId;
    if (o.cwd) cwd = o.cwd;
    if (o.timestamp) ts = o.timestamp;
    if (o.type === 'assistant') { const t = text(o.message); if (t) last = t; }
  }
  sessionId = sessionId || path.basename(file, '.jsonl');
  if (!cwd) return null;
  return {
    agent: 'claude',
    session_id: sessionId,
    title,
    cwd,
    updated_at: ts || statSync(file).mtime.toISOString(),
    last_message: trimSummary(last),
    file,
  };
}
