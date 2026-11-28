import { statSync } from 'node:fs';
import { parseJson, readFirstLine, readTailLines, trimSummary } from './tail.js';

function assistantText(o) {
  const p = o?.payload;
  if (!p) return null;
  if (o.type === 'event_msg' && p.type === 'task_complete' && p.last_agent_message) return p.last_agent_message;
  if (o.type === 'event_msg' && p.type === 'agent_message' && p.message) return p.message;
  if (o.type === 'response_item' && p.type === 'message' && p.role === 'assistant' && Array.isArray(p.content)) {
    return p.content.filter((c) => c?.type === 'output_text' && c.text).map((c) => c.text).join('\n') || null;
  }
  return null;
}

// One Codex rollout file -> AgentSessionRecord. Meta from the first line, message from the tail.
export function readCodexSession(file, titles = new Map()) {
  const meta = parseJson(readFirstLine(file));
  if (meta?.type !== 'session_meta' || !meta.payload) return null;
  const p = meta.payload;
  const threadId = p.id || p.session_id;
  if (!threadId) return null;
  let last = null; let lastTs = null;
  for (const line of readTailLines(file)) {
    const o = parseJson(line);
    if (!o) continue;
    if (o.timestamp) lastTs = o.timestamp;
    const text = assistantText(o);
    if (text) last = text;
  }
  const isSubagent = Boolean(p.forked_from_id) || Boolean(p.parent_thread_id && p.parent_thread_id !== threadId);
  return {
    agent: 'codex',
    session_id: isSubagent && p.session_id ? p.session_id : threadId,
    title: titles.get(threadId) || titles.get(p.session_id) || null,
    cwd: p.cwd || null,
    updated_at: lastTs || meta.timestamp || statSync(file).mtime.toISOString(),
    last_message: trimSummary(last),
    file,
  };
}

// ~/.codex/session_index.jsonl -> Map(id -> thread_name)
export function readCodexTitles(indexFile) {
  const titles = new Map();
  try {
    for (const line of readTailLines(indexFile, 4 * 1024 * 1024)) {
      const o = parseJson(line);
      if (o?.id && o.thread_name) titles.set(o.id, o.thread_name);
    }
  } catch { /* no index */ }
  return titles;
}
