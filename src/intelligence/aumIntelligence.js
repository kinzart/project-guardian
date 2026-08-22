// V0.2 AUM intelligence inspector: deeper, structured extraction from .memory/ than the V0.1
// aumInspector (which only needs enough for inventory listing). Kept as a separate module so
// the stable V0.1 inspector is untouched. Every read is bounded (prefix/tail byte caps), never
// rewrites the AUM, and never loads events.jsonl's full history.

import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import {
  parseSections,
  extractNarrativeField,
  extractSectionItems,
  extractDecisionLines,
  extractBlockerLines,
  extractKeywordTasks,
  extractChecklistItems,
} from './textSignals.js';

const PREFIX_BYTES = 8192;
const TAIL_BYTES = 8192;
const EVENTS_WINDOW = 20; // most recent N events considered, never the whole file

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

function analyzeNarrativeFile(filePath, fileLabel) {
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  const mtime = stat.mtime.toISOString();
  let text;
  try {
    text = readPrefix(filePath, PREFIX_BYTES);
  } catch (err) {
    return { mtime, readError: err.message };
  }

  const sections = parseSections(text);
  const tag = (items) => items.map((i) => ({ ...i, source: fileLabel }));

  return {
    mtime,
    focus: extractNarrativeField(text, sections, ['focus', 'foco atual', 'foco']),
    objective: extractNarrativeField(text, sections, ['objective', 'objetivo', 'goal']),
    context: extractNarrativeField(text, sections, ['context', 'contexto']),
    // Deliberately does NOT include a bare 'handoff' keyword: a handoff.md file's own H1 title
    // ("# AI Handoff — <project>") would match it and win, handing back the file's tagline
    // instead of an actual summary of where work stood.
    whereLeftOff: extractNarrativeField(text, sections, ['last summary', 'resumo', 'where.*left off', 'onde parei']),
    nextStep: extractNarrativeField(text, sections, ['next step', 'pr[oó]ximo passo']),
    decisions: tag([...extractDecisionLines(text), ...extractSectionItems(sections, ['decision', 'decis[aã]o'])]),
    blockers: tag([...extractBlockerLines(text), ...extractSectionItems(sections, ['blocker', 'bloque', 'impediment'])]),
    doneWork: tag(extractSectionItems(sections, ['^done$', 'completed', 'conclu[ií]do', 'trabalho conclu[ií]do'])),
    pendingWork: tag([
      ...extractSectionItems(sections, ['pending', 'pendente', 'next steps', 'pr[oó]ximos passos']),
      ...extractKeywordTasks(text)
        .filter((t) => t.status !== 'DONE')
        .map((t) => ({ text: t.text, matchedLine: t.matchedLine })),
    ]),
    files: tag(extractSectionItems(sections, ['^files$', '^arquivos$', 'relevant files'])),
    risks: tag(extractSectionItems(sections, ['^risks?$', '^riscos?$'])),
    checklist: tag(extractChecklistItems(text)),
  };
}

function analyzeStateJson(filePath) {
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  const mtime = stat.mtime.toISOString();
  try {
    const text = readPrefix(filePath, PREFIX_BYTES);
    const parsed = JSON.parse(text);
    return {
      mtime,
      status: typeof parsed.status === 'string' ? parsed.status : null,
      updatedAt: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
      focus: typeof parsed.focus === 'string' ? parsed.focus : typeof parsed.current_focus === 'string' ? parsed.current_focus : null,
      nextSteps: Array.isArray(parsed.next_steps) ? parsed.next_steps.filter((s) => typeof s === 'string') : [],
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers.filter((s) => typeof s === 'string') : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.filter((s) => typeof s === 'string') : [],
    };
  } catch {
    return { mtime, parseError: true };
  }
}

function analyzeEvents(filePath) {
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  const mtime = stat.mtime.toISOString();
  try {
    const tail = readTail(filePath, TAIL_BYTES);
    const lines = tail.split('\n').filter(Boolean).slice(-EVENTS_WINDOW);
    const parsed = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        parsed.push({
          ts: e.timestamp || e.ts || e.time || null,
          kind: typeof e.event === 'string' ? e.event : typeof e.type === 'string' ? e.type : null,
          text: typeof e.message === 'string' ? e.message : typeof e.note === 'string' ? e.note : null,
        });
      } catch {
        // skip a line that isn't valid JSON (e.g. the first line of a bounded tail read, which
        // may start mid-record) — this is a bounded window, not the authoritative full log
      }
    }
    const relevant = parsed.filter((e) => e.text || e.kind);
    return {
      mtime,
      lastEventTimestamp: parsed[parsed.length - 1]?.ts || null,
      recent: relevant.slice(-5),
    };
  } catch (err) {
    return { mtime, readError: err.message };
  }
}

export function analyzeAum(projectRoot) {
  const memoryDir = path.join(projectRoot, '.memory');
  if (!existsSync(memoryDir)) return { present: false };

  return {
    present: true,
    brief: analyzeNarrativeFile(path.join(memoryDir, 'BRIEF.md'), '.memory/BRIEF.md'),
    handoff: analyzeNarrativeFile(path.join(memoryDir, 'handoff.md'), '.memory/handoff.md'),
    state: analyzeStateJson(path.join(memoryDir, 'state.json')),
    events: analyzeEvents(path.join(memoryDir, 'events.jsonl')),
  };
}
