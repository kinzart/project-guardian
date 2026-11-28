import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const UNSAFE_CWD = /["%&|<>^\r\n]/;

const COMMANDS = {
  codex: (id) => `codex resume ${id}`,
  claude: (id) => `claude --resume ${id}`,
  hermes: (id) => `hermes --resume ${id}`,
};

export function resumeCommand(session) {
  if (!session || !COMMANDS[session.agent]) return null;
  if (!SAFE_ID.test(String(session.session_id || ''))) return null;
  if (!session.cwd || UNSAFE_CWD.test(session.cwd)) return null;
  return COMMANDS[session.agent](session.session_id);
}

export function fileUrl(filePath) {
  const p = filePath.replace(/\\/g, '/');
  const encoded = p.split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
  return `file:///${encoded.replace(/^\/+/, '')}`;
}

// Writes <vault>/_retomar/<agent>-<id>.cmd that reopens the session in its folder.
// Returns its file:/// URL, or null when the session can't be resumed safely.
export function writeLauncher(vaultPath, session) {
  const cmd = resumeCommand(session);
  if (!cmd) return null;
  const dir = path.join(vaultPath, '_retomar');
  const file = path.join(dir, `${session.agent}-${session.session_id}.cmd`);
  const body = ['@echo off', 'chcp 65001 >nul', `cd /d "${session.cwd}"`, cmd, ''].join('\r\n');
  if (!existsSync(file) || readFileSync(file, 'utf8') !== body) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body);
  }
  return fileUrl(file);
}
