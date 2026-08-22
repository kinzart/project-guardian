import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { isSecretFileName } from '../util/secrets.js';

const KNOWN_FILES = ['BRIEF.md', 'handoff.md', 'events.jsonl', 'state.json'];
const PREFIX_BYTES = 4096;
const TAIL_BYTES = 8192;

function readPrefix(filePath, maxBytes) {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function readTail(filePath, maxBytes) {
  const size = statSync(filePath).size;
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function extractStatusLine(text) {
  const m = text.match(/^\s*(status|estado)\s*:\s*(.+)$/im);
  return m ? m[2].trim() : null;
}

function extractTitle(text) {
  const m = text.match(/^\s*#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

// Detects .memory/ and, for the known files that exist, extracts a bounded amount of
// inventory-relevant metadata. Never rewrites the AUM, never loads whole files, never
// duplicates its event history.
export function inspectAum(projectRoot) {
  const memoryDir = path.join(projectRoot, '.memory');
  if (!existsSync(memoryDir)) return { present: false };

  const result = { present: true, files: {}, errors: [] };

  for (const fileName of KNOWN_FILES) {
    if (isSecretFileName(fileName)) continue; // defense in depth, none of these match today
    const filePath = path.join(memoryDir, fileName);
    if (!existsSync(filePath)) continue;

    const stat = statSync(filePath);
    const entry = { exists: true, size: stat.size, mtime: stat.mtime.toISOString() };

    try {
      if (fileName === 'events.jsonl') {
        const tail = readTail(filePath, TAIL_BYTES);
        const lines = tail.split('\n').filter(Boolean);
        const lastLine = lines[lines.length - 1];
        if (lastLine) {
          try {
            const parsed = JSON.parse(lastLine);
            entry.lastEventTimestamp = parsed.timestamp || parsed.ts || parsed.time || null;
          } catch {
            entry.parseWarning = 'last line of events.jsonl is not valid JSON (possibly truncated tail read)';
          }
        }
      } else if (fileName === 'state.json') {
        const prefix = readPrefix(filePath, PREFIX_BYTES);
        try {
          const parsed = JSON.parse(prefix);
          entry.status = typeof parsed.status === 'string' ? parsed.status : null;
          entry.updatedAt = typeof parsed.updated_at === 'string' ? parsed.updated_at : null;
        } catch {
          entry.parseError = true;
          result.errors.push(`state.json parse failed (may exceed ${PREFIX_BYTES}-byte bounded read)`);
        }
      } else {
        const prefix = readPrefix(filePath, PREFIX_BYTES);
        entry.title = extractTitle(prefix);
        entry.statusLine = extractStatusLine(prefix);
      }
    } catch (err) {
      entry.readError = err.message;
      result.errors.push(`${fileName}: ${err.message}`);
    }

    result.files[fileName] = entry;
  }

  return result;
}
