import { existsSync } from 'node:fs';
import path from 'node:path';
import { trimSummary } from './tail.js';

// Best-effort reader for Hermes Agent's SQLite state. The schema is not a stable contract, so
// every step is guarded and any surprise yields []. Never throws.
export async function readHermesSessions(hermesHome, { limit = 200 } = {}) {
  if (!hermesHome) return [];
  const dbFile = ['state.db', path.join('state', 'state.db')].map((f) => path.join(hermesHome, f)).find((f) => existsSync(f));
  if (!dbFile) return [];
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbFile, { readOnly: true });
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const sCols = cols('sessions'); const mCols = cols('messages');
    if (!sCols.includes('id') || !mCols.includes('session_id')) return [];
    const startCol = sCols.find((c) => ['updated_at', 'ended_at', 'started_at'].includes(c));
    const rows = db.prepare(`SELECT * FROM sessions ${startCol ? `ORDER BY ${startCol} DESC` : ''} LIMIT ?`).all(limit);
    const lastMsg = mCols.includes('role') && mCols.includes('content')
      ? db.prepare(`SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1`)
      : null;
    return rows.map((r) => {
      const when = r[startCol];
      const iso = typeof when === 'number' ? new Date(when < 1e12 ? when * 1000 : when).toISOString() : (when || null);
      return {
        agent: 'hermes',
        session_id: String(r.id),
        title: r.title || null,
        cwd: r.cwd || r.workdir || r.working_directory || null,
        updated_at: iso,
        last_message: trimSummary(lastMsg?.get(r.id)?.content),
        file: dbFile,
      };
    });
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
