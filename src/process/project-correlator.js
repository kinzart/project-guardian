// Process -> project correlation — see SPEC_V0.4.md "Project correlation". A process existing
// is never proof of which project it works on; every result is { projectId, confidence,
// evidence[] }, and "no evidence" (projectId: null, confidence: UNKNOWN) is a valid, expected,
// common outcome — never defaulted to "the last modified project".

import { CONFIDENCE } from '../intelligence/field.js';

const RANK = { [CONFIDENCE.UNKNOWN]: 0, [CONFIDENCE.LOW]: 1, [CONFIDENCE.MEDIUM]: 2, [CONFIDENCE.HIGH]: 3 };

function isUnderRoot(absPath, rootPath) {
  const a = absPath.replace(/\\/g, '/').toLowerCase();
  const r = rootPath.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
  return a === r || a.startsWith(`${r}/`);
}

// Deepest-matching root_path among ALL known projects — this already resolves to the correct
// family MEMBER on its own (every member has its own root_path entry in `projects`), so no
// separate related_roots lookup is needed here. Exported for reuse by src/shell/correlator.js.
export function resolveProjectForPath(absPath, projects) {
  if (!absPath) return null;
  let best = null;
  for (const project of projects) {
    if (isUnderRoot(absPath, project.root_path) && (!best || project.root_path.length > best.root_path.length)) {
      best = project;
    }
  }
  return best;
}

// record: { runtimeId, timestamp, executablePath }
// commandMetadata: { pathLikeArgs } from sanitizer.js
// tree: ProcessTree
// correlations: Map<runtimeId, { projectId, confidence }> of already-resolved processes this run
// recentFsEvents: watch_events rows, each { project_id, occurred_at }
// shellCwd: explicit CWD of the process's parent shell, when the parent is a known shell session
//   (see SPEC_V0.5A.md section 8) — supplied by observer.js via the shell-session registry.
export function correlateProject({
  record,
  commandMetadata,
  tree,
  projects,
  correlations = new Map(),
  recentFsEvents = [],
  correlationWindowMs = 4000,
  shellCwd = null,
}) {
  // 0. Direct — parent process is a known shell session reporting an explicit CWD that resolves
  //    under a project root. Checked first: this is the most literal, unambiguous evidence V0.5A
  //    can produce (see SPEC_V0.5A.md section 8).
  if (shellCwd) {
    const project = resolveProjectForPath(shellCwd, projects);
    if (project) {
      return {
        projectId: project.id,
        confidence: CONFIDENCE.HIGH,
        evidence: ['parent process is a known shell session (source: shell hook)', `shell explicit CWD resolves under project root: ${project.name}`],
      };
    }
  }

  // 1. Direct — a sanitized command-line argument resolves under a known project root.
  for (const arg of commandMetadata?.pathLikeArgs || []) {
    const project = resolveProjectForPath(arg, projects);
    if (project) {
      return {
        projectId: project.id,
        confidence: CONFIDENCE.HIGH,
        evidence: [`command-line argument path resolves under project root: ${project.name}`],
      };
    }
  }

  // 2. Direct — the executable itself lives inside a project root.
  if (record.executablePath) {
    const project = resolveProjectForPath(record.executablePath, projects);
    if (project) {
      return {
        projectId: project.id,
        confidence: CONFIDENCE.HIGH,
        evidence: [`executable path is located inside project root: ${project.name}`],
      };
    }
  }

  const weakSignals = [];

  // 3. Inherited — nearest ancestor in the process tree already correlated to a project, capped
  //    one level below the ancestor's own confidence (never re-promoted to HIGH by inheritance).
  const ancestors = tree.ancestors(record.runtimeId);
  for (const ancestor of ancestors) {
    const ancestorCorrelation = correlations.get(ancestor.runtimeId);
    if (ancestorCorrelation?.projectId) {
      const inherited = ancestorCorrelation.confidence === CONFIDENCE.HIGH ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;
      weakSignals.push({
        projectId: ancestorCorrelation.projectId,
        confidence: inherited,
        kind: 'inherited',
        note: `inherited from parent process ${ancestor.processName} (correlated ${ancestorCorrelation.confidence})`,
      });
      break; // nearest correlated ancestor only
    }
  }

  // 4. Temporal — filesystem activity for a project close in time to this process's start.
  //    Alone this can never exceed LOW, however many matching events there are (see below).
  const startedAtMs = new Date(record.timestamp).getTime();
  for (const evt of recentFsEvents) {
    if (!evt.project_id) continue;
    const occurredMs = new Date(evt.occurred_at).getTime();
    if (Number.isFinite(occurredMs) && Math.abs(occurredMs - startedAtMs) <= correlationWindowMs) {
      weakSignals.push({
        projectId: evt.project_id,
        confidence: CONFIDENCE.LOW,
        kind: 'temporal',
        note: `filesystem activity for this project occurred within ${correlationWindowMs}ms of process start`,
      });
    }
  }

  if (!weakSignals.length) return { projectId: null, confidence: CONFIDENCE.UNKNOWN, evidence: [] };

  const byProject = new Map();
  for (const signal of weakSignals) {
    const entry = byProject.get(signal.projectId) || { rank: 0, notes: [], kinds: new Set() };
    entry.rank = Math.max(entry.rank, RANK[signal.confidence]);
    entry.notes.push(signal.note);
    entry.kinds.add(signal.kind);
    byProject.set(signal.projectId, entry);
  }

  let best = null;
  for (const [projectId, entry] of byProject) {
    if (!best || entry.rank > best.entry.rank) best = { projectId, entry };
  }

  // Two or more DISTINCT kinds of weak evidence for the same project may combine up to MEDIUM;
  // repeated instances of the same kind (e.g. several temporal hits) never do that alone.
  let rank = best.entry.rank;
  if (best.entry.kinds.size >= 2) rank = Math.max(rank, RANK[CONFIDENCE.MEDIUM]);
  rank = Math.min(rank, RANK[CONFIDENCE.MEDIUM]); // weak signals never reach HIGH without direct evidence

  const confidence = Object.keys(RANK).find((key) => RANK[key] === rank);
  return { projectId: best.projectId, confidence, evidence: best.entry.notes };
}
