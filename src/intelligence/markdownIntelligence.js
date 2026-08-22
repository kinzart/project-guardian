// V0.2 markdown intelligence: task/decision/blocker/status extraction from the same bounded set
// of high-value filenames the V0.1 markdownInspector already knows about (see
// src/inspectors/markdownInspector.js KNOWN_MARKDOWN_FILES), but reading the content itself
// rather than just headings/counts. Kept separate so the stable V0.1 inspector is untouched.

import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { extractChecklistItems, extractKeywordTasks, extractDecisionLines, extractBlockerLines } from './textSignals.js';
import { KNOWN_MARKDOWN_FILES } from '../inspectors/markdownInspector.js';

const PREFIX_BYTES = 20 * 1024;

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

// Lower-priority evidence than AUM (see SPEC_V0.2.md authority order): STATUS.md first, then
// task-tracking files, then general narrative docs.
const READ_ORDER = ['STATUS.md', 'TASKS.md', 'TODO.md', 'ROADMAP.md', 'README.md', 'SPEC.md', 'ACCEPTANCE.md', 'AGENTS.md', 'CLAUDE.md', 'MINDMAP.md'];

export function analyzeMarkdown(projectRoot) {
  const result = { tasks: [], decisions: [], blockers: [], statusLine: null, statusSource: null, statusMtime: null };

  for (const fileName of READ_ORDER) {
    if (!KNOWN_MARKDOWN_FILES.includes(fileName)) continue;
    const filePath = path.join(projectRoot, fileName);
    if (!existsSync(filePath)) continue;

    const stat = statSync(filePath);
    const mtime = stat.mtime.toISOString();
    let text;
    try {
      text = readPrefix(filePath, PREFIX_BYTES);
    } catch {
      continue;
    }

    for (const c of extractChecklistItems(text)) result.tasks.push({ ...c, source: fileName, mtime });
    for (const t of extractKeywordTasks(text)) result.tasks.push({ ...t, source: fileName, mtime });
    for (const d of extractDecisionLines(text)) result.decisions.push({ ...d, source: fileName, mtime });
    for (const b of extractBlockerLines(text)) result.blockers.push({ ...b, source: fileName, mtime });

    if (!result.statusLine) {
      const m = text.match(/^\s*(status|estado)\s*:\s*(.+)$/im);
      if (m) {
        result.statusLine = m[2].trim();
        result.statusSource = fileName;
        result.statusMtime = mtime;
      }
    }
  }

  return result;
}
