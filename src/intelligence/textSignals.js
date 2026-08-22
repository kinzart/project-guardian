// Deterministic, regex-based text signal extraction shared by the AUM and Markdown intelligence
// inspectors. No LLM, no network — every function here is a pure function of already-bounded
// text that was read by the caller (this module never touches the filesystem itself).

export function parseSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [{ heading: null, level: 0, bodyLines: [] }];
  let current = sections[0];
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      current = { heading: m[2].trim(), level: m[1].length, bodyLines: [] };
      sections.push(current);
    } else {
      current.bodyLines.push(line);
    }
  }
  return sections;
}

export function stripListMarker(line) {
  return line
    .replace(/^[-*]\s*\[[ xX]\]\s*/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
}

// Finds a value for a concept identified by `keywords` (each a raw regex-source fragment, no
// anchors needed) two ways: (1) an inline "Label: value" line anywhere in the text, (2) a
// heading matching one of the keywords, taking the first non-empty body line under it. Returns
// { value, matchedLine } or null if neither is found.
export function extractNarrativeField(text, sections, keywords) {
  for (const kw of keywords) {
    const re = new RegExp(`^\\s*(?:${kw})\\s*:\\s*(.+)$`, 'im');
    const m = text.match(re);
    if (m && m[1].trim()) return { value: m[1].trim(), matchedLine: m[0].trim() };
  }
  for (const section of sections) {
    if (!section.heading) continue;
    if (keywords.some((kw) => new RegExp(kw, 'i').test(section.heading))) {
      const firstLine = section.bodyLines.map((l) => l.trim()).find((l) => l && !/^#/.test(l));
      if (firstLine) return { value: stripListMarker(firstLine), matchedLine: firstLine };
    }
  }
  return null;
}

// All non-empty lines under any heading matching one of `headingKeywords`, list-marker stripped.
export function extractSectionItems(sections, headingKeywords) {
  const items = [];
  for (const section of sections) {
    if (!section.heading) continue;
    if (!headingKeywords.some((kw) => new RegExp(kw, 'i').test(section.heading))) continue;
    for (const raw of section.bodyLines) {
      const line = raw.trim();
      if (!line || /^#/.test(line)) continue;
      const text = stripListMarker(line);
      if (text) items.push({ text, matchedLine: line });
    }
  }
  return items;
}

export function extractChecklistItems(text) {
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/);
    if (m) items.push({ text: m[2].trim(), done: m[1].toLowerCase() === 'x', matchedLine: raw.trim() });
  }
  return items;
}

// Explicit keyword-tagged task lines: "TODO: ...", "- NEXT: ...", etc. Deliberately
// case-sensitive on the keyword (spec shows these as literal uppercase markers) to avoid
// matching the word "todo" inside ordinary prose.
const KEYWORD_TASK_RE = /^(?:[-*]\s*)?(TODO|PENDING|BLOCKED|NEXT|DONE)\s*:?\s*(.+)$/;

export function extractKeywordTasks(text) {
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(KEYWORD_TASK_RE);
    if (m) items.push({ status: m[1], text: m[2].trim(), matchedLine: line });
  }
  return items;
}

const DECISION_LABEL_RE = /^(?:[-*]\s*)?(decided|decision|decis[aã]o|decidido|chosen|approved)\s*:\s*(.+)$/i;
const DECISION_PHRASE_RE = /\b(vamos usar|n[ãa]o usar)\b/i;

// Explicit decision markers, deliberately conservative: only lines with a "Decision:"-shaped
// label, or containing one of a small set of decisive Portuguese phrases, ever qualify — a
// merely descriptive sentence is never treated as a decision.
export function extractDecisionLines(text) {
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const labeled = line.match(DECISION_LABEL_RE);
    if (labeled) {
      items.push({ text: labeled[2].trim(), matchedLine: line });
      continue;
    }
    if (DECISION_PHRASE_RE.test(line)) items.push({ text: line, matchedLine: line });
  }
  return items;
}

const BLOCKER_LINE_PATTERNS = [
  /^(?:[-*]\s*)?blocked\s*:?\s*(.*)$/i,
  /^(?:[-*]\s*)?bloqueado\s*:?\s*(.*)$/i,
  /^(?:[-*]\s*)?blocker\s*:?\s*(.*)$/i,
  /pendente de credencial/i,
  /aguardando acesso/i,
  /falha externa/i,
  /depend[êe]ncia ausente/i,
  /manual action required/i,
];

export function extractBlockerLines(text) {
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (BLOCKER_LINE_PATTERNS.some((re) => re.test(line))) items.push({ text: stripListMarker(line), matchedLine: line });
  }
  return items;
}

export function dedupeByText(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.text.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
