import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';

const KNOWN_FILES = [
  'README.md',
  'MINDMAP.md',
  'TASKS.md',
  'TODO.md',
  'ROADMAP.md',
  'SPEC.md',
  'ACCEPTANCE.md',
  'AGENTS.md',
  'CLAUDE.md',
  'STATUS.md',
];

const PREFIX_BYTES = 20 * 1024;
const MAX_HEADINGS = 25;

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

function extractHeadings(text) {
  const headings = [];
  const re = /^(#{1,6})\s+(.+)$/gm;
  let m;
  while ((m = re.exec(text)) && headings.length < MAX_HEADINGS) {
    headings.push({ level: m[1].length, text: m[2].trim() });
  }
  return headings;
}

function extractStatusLine(text) {
  const m = text.match(/^\s*(status|estado)\s*:\s*(.+)$/im);
  return m ? m[2].trim() : null;
}

function extractDates(text) {
  const re = /\b\d{4}-\d{2}-\d{2}\b/g;
  const found = text.match(re) || [];
  return Array.from(new Set(found)).slice(0, 10);
}

// Inspects only the known, bounded set of high-value markdown filenames at project root.
// Reads at most PREFIX_BYTES per file. Never indexes arbitrary/large markdown trees.
export function inspectMarkdown(projectRoot) {
  const found = {};

  for (const fileName of KNOWN_FILES) {
    const filePath = path.join(projectRoot, fileName);
    if (!existsSync(filePath)) continue;

    const stat = statSync(filePath);
    let text = '';
    try {
      text = readPrefix(filePath, PREFIX_BYTES);
    } catch {
      found[fileName] = { exists: true, mtime: stat.mtime.toISOString(), readError: true };
      continue;
    }

    const headings = extractHeadings(text);
    found[fileName] = {
      exists: true,
      mtime: stat.mtime.toISOString(),
      size: stat.size,
      title: headings[0]?.text || null,
      headings,
      checkboxesOpen: (text.match(/^\s*-\s*\[\s\]/gm) || []).length,
      checkboxesDone: (text.match(/^\s*-\s*\[[xX]\]/gm) || []).length,
      todoCount: (text.match(/\bTODO\b/g) || []).length,
      statusLine: extractStatusLine(text),
      datesFound: extractDates(text),
    };
  }

  return found;
}

export { KNOWN_FILES as KNOWN_MARKDOWN_FILES };
