import { closeSync, openSync, readSync, statSync } from 'node:fs';

function readRange(file, start, length) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } finally { closeSync(fd); }
}

// Complete lines from the last maxBytes of a file (a partial first line is dropped).
export function readTailLines(file, maxBytes = 262144) {
  const size = statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const text = readRange(file, start, size - start);
  const lines = text.split(/\r?\n/);
  if (start > 0) lines.shift();
  return lines.filter(Boolean);
}

// The first line of a file, reading at most maxBytes.
export function readFirstLine(file, maxBytes = 65536) {
  const text = readRange(file, 0, Math.min(maxBytes, statSync(file).size));
  const i = text.indexOf('\n');
  return i >= 0 ? text.slice(0, i) : text;
}

export function parseJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

export const SUMMARY_MAX = 600;
export function trimSummary(text) {
  if (!text) return null;
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > SUMMARY_MAX ? `${clean.slice(0, SUMMARY_MAX - 1)}…` : clean;
}
