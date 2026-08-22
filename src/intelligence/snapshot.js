// Builds the per-project `project_intelligence` snapshot (see ARCHITECTURE.md "V0.2 —
// intelligence layer") from already-extracted AUM/Markdown/Git raw signals, following the
// source-authority order frozen in SPEC_V0.2.md. Pure function, no I/O, no network, no LLM.

import { CONFIDENCE, field, evidence } from './field.js';
import { dedupeByText } from './textSignals.js';

function resolveCurrentFocus({ aum, markdown }) {
  if (aum?.present) {
    if (aum.state?.focus) {
      return field(aum.state.focus, CONFIDENCE.HIGH, [evidence('.memory/state.json', aum.state.focus, aum.state.updatedAt || aum.state.mtime)]);
    }
    if (aum.brief?.focus) {
      return field(aum.brief.focus.value, CONFIDENCE.HIGH, [evidence('.memory/BRIEF.md', aum.brief.focus.matchedLine, aum.brief.mtime)]);
    }
    if (aum.handoff?.nextStep) {
      return field(aum.handoff.nextStep.value, CONFIDENCE.MEDIUM, [evidence('.memory/handoff.md', aum.handoff.nextStep.matchedLine, aum.handoff.mtime)]);
    }
    if (aum.handoff?.whereLeftOff) {
      return field(aum.handoff.whereLeftOff.value, CONFIDENCE.MEDIUM, [evidence('.memory/handoff.md', aum.handoff.whereLeftOff.matchedLine, aum.handoff.mtime)]);
    }
    if (aum.events?.recent?.length) {
      const last = aum.events.recent[aum.events.recent.length - 1];
      if (last.text) return field(last.text, CONFIDENCE.LOW, [evidence('.memory/events.jsonl', last.text, last.ts)]);
    }
  }
  if (markdown?.statusLine) {
    return field(markdown.statusLine, CONFIDENCE.LOW, [evidence(markdown.statusSource, markdown.statusLine, markdown.statusMtime)]);
  }
  return field(null, CONFIDENCE.UNKNOWN, []);
}

function resolveLastMeaningfulWork({ aum, git }) {
  if (aum?.present && aum.handoff?.whereLeftOff) {
    return {
      value: aum.handoff.whereLeftOff.value,
      at: aum.handoff.mtime,
      confidence: CONFIDENCE.HIGH,
      evidence: [evidence('.memory/handoff.md', aum.handoff.whereLeftOff.matchedLine, aum.handoff.mtime)],
    };
  }
  if (aum?.present && aum.events?.recent?.length) {
    const last = aum.events.recent[aum.events.recent.length - 1];
    if (last.text) {
      return { value: last.text, at: last.ts, confidence: CONFIDENCE.MEDIUM, evidence: [evidence('.memory/events.jsonl', last.text, last.ts)] };
    }
  }
  if (git?.lastCommit) {
    // Evidence only — a commit message is never sufficient on its own to declare completion.
    const value = git.lastCommit.message || `commit ${git.lastCommit.hash.slice(0, 7)}`;
    return { value, at: git.lastCommit.date, confidence: CONFIDENCE.MEDIUM, evidence: [evidence('git', value, git.lastCommit.date)] };
  }
  return { value: null, at: null, confidence: CONFIDENCE.UNKNOWN, evidence: [] };
}

function collectNextSteps({ aum }) {
  const items = [];
  if (aum?.state?.nextSteps?.length) {
    for (const s of aum.state.nextSteps) {
      items.push({ text: s, status: 'PENDING', confidence: CONFIDENCE.HIGH, evidence: [evidence('.memory/state.json', s, aum.state.updatedAt || aum.state.mtime)] });
    }
  }
  if (aum?.present) {
    if (aum.handoff?.nextStep) {
      items.push({
        text: aum.handoff.nextStep.value,
        status: 'NEXT',
        confidence: CONFIDENCE.HIGH,
        evidence: [evidence('.memory/handoff.md', aum.handoff.nextStep.matchedLine, aum.handoff.mtime)],
      });
    }
    for (const p of aum.handoff?.pendingWork || []) {
      items.push({ text: p.text, status: 'PENDING', confidence: CONFIDENCE.HIGH, evidence: [evidence(p.source, p.matchedLine, aum.handoff.mtime)] });
    }
    for (const p of aum.brief?.pendingWork || []) {
      items.push({ text: p.text, status: 'PENDING', confidence: CONFIDENCE.MEDIUM, evidence: [evidence(p.source, p.matchedLine, aum.brief.mtime)] });
    }
  }
  return dedupeByText(items).slice(0, 20);
}

function collectOpenTasks({ aum, markdown }) {
  const items = [];
  if (aum?.present) {
    for (const c of aum.brief?.checklist || []) {
      if (!c.done) items.push({ text: c.text, status: 'OPEN', confidence: CONFIDENCE.MEDIUM, evidence: [evidence(c.source, c.matchedLine, aum.brief.mtime)] });
    }
    for (const c of aum.handoff?.checklist || []) {
      if (!c.done) items.push({ text: c.text, status: 'OPEN', confidence: CONFIDENCE.MEDIUM, evidence: [evidence(c.source, c.matchedLine, aum.handoff.mtime)] });
    }
  }
  if (markdown) {
    for (const t of markdown.tasks) {
      if (t.done === false) items.push({ text: t.text, status: 'OPEN', confidence: CONFIDENCE.LOW, evidence: [evidence(t.source, t.matchedLine, t.mtime)] });
      else if (t.status && t.status !== 'DONE') items.push({ text: t.text, status: t.status, confidence: CONFIDENCE.LOW, evidence: [evidence(t.source, t.matchedLine, t.mtime)] });
    }
  }
  return dedupeByText(items).slice(0, 30);
}

function collectCompletedTasks({ aum, markdown }) {
  const items = [];
  if (aum?.present) {
    for (const c of aum.brief?.checklist || []) {
      if (c.done) items.push({ text: c.text, confidence: CONFIDENCE.MEDIUM, evidence: [evidence(c.source, c.matchedLine, aum.brief.mtime)] });
    }
    for (const c of aum.handoff?.checklist || []) {
      if (c.done) items.push({ text: c.text, confidence: CONFIDENCE.MEDIUM, evidence: [evidence(c.source, c.matchedLine, aum.handoff.mtime)] });
    }
    for (const d of aum.handoff?.doneWork || []) {
      items.push({ text: d.text, confidence: CONFIDENCE.HIGH, evidence: [evidence(d.source, d.matchedLine, aum.handoff.mtime)] });
    }
  }
  if (markdown) {
    for (const t of markdown.tasks) {
      if (t.done === true || t.status === 'DONE') items.push({ text: t.text, confidence: CONFIDENCE.LOW, evidence: [evidence(t.source, t.matchedLine, t.mtime)] });
    }
  }
  return dedupeByText(items).slice(0, 30);
}

function collectBlockers({ aum, markdown }) {
  const items = [];
  if (aum?.state?.blockers?.length) {
    for (const b of aum.state.blockers) {
      items.push({ text: b, confidence: CONFIDENCE.HIGH, evidence: [evidence('.memory/state.json', b, aum.state.updatedAt || aum.state.mtime)] });
    }
  }
  if (aum?.present) {
    for (const b of aum.brief?.blockers || []) items.push({ text: b.text, confidence: CONFIDENCE.HIGH, evidence: [evidence(b.source, b.matchedLine, aum.brief.mtime)] });
    for (const b of aum.handoff?.blockers || []) items.push({ text: b.text, confidence: CONFIDENCE.HIGH, evidence: [evidence(b.source, b.matchedLine, aum.handoff.mtime)] });
  }
  if (markdown) {
    for (const b of markdown.blockers) items.push({ text: b.text, confidence: CONFIDENCE.MEDIUM, evidence: [evidence(b.source, b.matchedLine, b.mtime)] });
    for (const t of markdown.tasks) {
      if (t.status === 'BLOCKED') items.push({ text: t.text, confidence: CONFIDENCE.MEDIUM, evidence: [evidence(t.source, t.matchedLine, t.mtime)] });
    }
  }
  return dedupeByText(items).slice(0, 20);
}

function collectDecisions({ aum, markdown }) {
  const items = [];
  if (aum?.state?.decisions?.length) {
    for (const d of aum.state.decisions) {
      items.push({ text: d, at: aum.state.updatedAt || aum.state.mtime, confidence: CONFIDENCE.HIGH, evidence: [evidence('.memory/state.json', d, aum.state.updatedAt || aum.state.mtime)] });
    }
  }
  if (aum?.present) {
    for (const d of aum.brief?.decisions || []) items.push({ text: d.text, at: aum.brief.mtime, confidence: CONFIDENCE.HIGH, evidence: [evidence(d.source, d.matchedLine, aum.brief.mtime)] });
    for (const d of aum.handoff?.decisions || []) items.push({ text: d.text, at: aum.handoff.mtime, confidence: CONFIDENCE.HIGH, evidence: [evidence(d.source, d.matchedLine, aum.handoff.mtime)] });
  }
  if (markdown) {
    for (const d of markdown.decisions) items.push({ text: d.text, at: d.mtime, confidence: CONFIDENCE.MEDIUM, evidence: [evidence(d.source, d.matchedLine, d.mtime)] });
  }
  return dedupeByText(items).slice(0, 20);
}

function collectRisks({ aum }) {
  const items = [];
  if (aum?.present) {
    for (const r of aum.handoff?.risks || []) items.push({ text: r.text, confidence: CONFIDENCE.HIGH, evidence: [evidence(r.source, r.matchedLine, aum.handoff.mtime)] });
    for (const r of aum.brief?.risks || []) items.push({ text: r.text, confidence: CONFIDENCE.MEDIUM, evidence: [evidence(r.source, r.matchedLine, aum.brief.mtime)] });
  }
  return dedupeByText(items).slice(0, 20);
}

// Focused, testable conflict rule (see SPEC_V0.2.md "Conflitos" — the state.json-done-vs-
// TASKS.md-pending example): if the resolved completion_state is DONE, but an open task exists
// whose evidence comes from a source OTHER than the one that produced completion_state, that is
// a visible conflict. Guardian does not silently resolve it — the completion_state stands
// (it's already the most-authoritative source per SPEC order), but the disagreement is recorded.
function detectConflicts({ project, openTasks }) {
  const conflicts = [];
  const resolvedSource = project.completion_detail?.source;
  if (project.status.completion_state === 'DONE' && resolvedSource) {
    const conflicting = openTasks.find((t) => !t.evidence.some((e) => e.source === resolvedSource));
    if (conflicting) {
      const otherSource = conflicting.evidence[0]?.source;
      conflicts.push({
        field: 'completion_state',
        source_a: resolvedSource,
        source_b: otherSource,
        explanation: `${resolvedSource} declares completion DONE, but ${otherSource} still lists open work: "${conflicting.text}"`,
      });
    }
  }
  return conflicts;
}

function sourceHealth({ project, aum, markdown, git }) {
  const aumHealth = !aum?.present ? 'none' : aum.brief || aum.handoff || aum.state ? 'good' : 'partial';
  const gitHealth = !project.has_git ? 'none' : git?.errors?.length ? 'errors' : 'ok';
  const hasDocsSignal = markdown && (markdown.tasks.length || markdown.decisions.length || markdown.blockers.length || markdown.statusLine);
  const docsHealth = hasDocsSignal ? 'some' : 'none';
  return { aum: aumHealth, git: gitHealth, docs: docsHealth };
}

function buildSummary({ project, currentFocus }) {
  if (currentFocus.value) {
    return field(`${project.status.completion_state}; focus: ${currentFocus.value}`, currentFocus.confidence, currentFocus.evidence);
  }
  return field(null, CONFIDENCE.UNKNOWN, []);
}

export function buildProjectIntelligenceSnapshot({ project, aum, markdown, git, fingerprint, now = new Date() }) {
  const currentFocus = resolveCurrentFocus({ aum, markdown });
  const lastMeaningfulWork = resolveLastMeaningfulWork({ aum, git });
  const nextSteps = collectNextSteps({ aum });
  const openTasks = collectOpenTasks({ aum, markdown });
  const completedTasks = collectCompletedTasks({ aum, markdown });
  const blockers = collectBlockers({ aum, markdown });
  const decisions = collectDecisions({ aum, markdown });
  const risks = collectRisks({ aum });
  const conflicts = detectConflicts({ project, openTasks });
  const health = sourceHealth({ project, aum, markdown, git });
  const summary = buildSummary({ project, currentFocus });

  return {
    project_id: project.id,
    generated_at: now.toISOString(),
    activity_state: project.status.activity_state,
    completion_state: project.status.completion_state,
    current_focus: currentFocus,
    last_meaningful_work: lastMeaningfulWork,
    next_steps: nextSteps,
    blockers,
    recent_decisions: decisions,
    open_tasks: openTasks,
    completed_tasks: completedTasks,
    risks,
    summary,
    source_health: health,
    conflicts,
    fingerprint,
  };
}
