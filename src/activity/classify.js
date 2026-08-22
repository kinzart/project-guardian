const COMPLETION_KEYWORDS = [
  [/^(done|complete|completed|conclu[ií]do|finalizado)$/i, 'DONE'],
  [/^(in.?progress|em.?andamento|andamento)$/i, 'IN_PROGRESS'],
  [/^(blocked|bloqueado|impedido)$/i, 'BLOCKED'],
  [/^(planning|planejamento|planejando)$/i, 'PLANNING'],
  [/^(partial|parcial)$/i, 'PARTIAL'],
  [/^(archived|arquivado)$/i, 'ARCHIVED'],
];

function normalizeCompletion(rawValue) {
  const trimmed = rawValue.trim();
  for (const [re, state] of COMPLETION_KEYWORDS) {
    if (re.test(trimmed)) return state;
  }
  return null;
}

function hoursSince(isoDate, now) {
  if (!isoDate) return null;
  const t = new Date(isoDate).getTime();
  if (Number.isNaN(t)) return null;
  return (now - t) / (1000 * 60 * 60);
}

// activity_state is a pure function of recency; completion_state defaults to UNKNOWN and is
// only ever overridden by an explicit Status:/Estado: line found by an inspector, with the
// evidence recorded. Never inferred from recency, checkbox ratios, or file counts alone.
export function classify({ git, aum, markdown, rootMtimeIso }, thresholds, now = Date.now()) {
  const activityEvidence = [];
  const timestamps = [];

  if (git?.lastCommitDate) {
    timestamps.push(git.lastCommitDate);
    activityEvidence.push(`git: last commit ${git.lastCommitDate}`);
  }
  if (aum?.present) {
    for (const [fileName, info] of Object.entries(aum.files || {})) {
      if (info.lastEventTimestamp) {
        timestamps.push(info.lastEventTimestamp);
        activityEvidence.push(`.memory/${fileName}: last event ${info.lastEventTimestamp}`);
      } else if (info.mtime) {
        timestamps.push(info.mtime);
        activityEvidence.push(`.memory/${fileName}: mtime ${info.mtime}`);
      }
    }
  }
  if (markdown) {
    for (const [fileName, info] of Object.entries(markdown)) {
      if (info.mtime) {
        timestamps.push(info.mtime);
        activityEvidence.push(`${fileName}: mtime ${info.mtime}`);
      }
    }
  }
  if (rootMtimeIso) {
    timestamps.push(rootMtimeIso);
    activityEvidence.push(`project root: mtime ${rootMtimeIso}`);
  }

  let freshest = null;
  for (const ts of timestamps) {
    const t = new Date(ts).getTime();
    if (!Number.isNaN(t) && (freshest === null || t > freshest)) freshest = t;
  }

  const ageHours = freshest === null ? null : (now - freshest) / (1000 * 60 * 60);

  let activityState;
  if (ageHours === null) {
    activityState = 'DORMANT';
  } else if (ageHours <= thresholds.activeHours) {
    activityState = 'ACTIVE';
  } else if (ageHours <= thresholds.warmDays * 24) {
    activityState = 'WARM';
  } else if (ageHours <= thresholds.staleDays * 24) {
    activityState = 'STALE';
  } else {
    activityState = 'DORMANT';
  }

  let completionState = 'UNKNOWN';
  const completionEvidence = [];

  // Authority order (see SPEC_V0.2.md): .memory/state.json, then .memory/BRIEF.md, then
  // .memory/handoff.md, all ahead of any markdown file — an explicit AUM status always outranks
  // a stray "Status:" line in README/TASKS/etc. Within markdown, STATUS.md outranks the rest.
  const statusCandidates = [];
  if (aum?.present) {
    const stateInfo = aum.files?.['state.json'];
    if (stateInfo?.status) {
      statusCandidates.push({ source: '.memory/state.json', line: stateInfo.status, updatedAt: stateInfo.updatedAt || stateInfo.mtime || null });
    }
    for (const fileName of ['BRIEF.md', 'handoff.md']) {
      const info = aum.files?.[fileName];
      if (info?.statusLine) statusCandidates.push({ source: `.memory/${fileName}`, line: info.statusLine, updatedAt: info.mtime || null });
    }
  }
  if (markdown) {
    const markdownOrder = ['STATUS.md', 'TASKS.md', 'TODO.md', 'ROADMAP.md', 'README.md', 'SPEC.md', 'ACCEPTANCE.md', 'AGENTS.md', 'CLAUDE.md', 'MINDMAP.md'];
    for (const fileName of markdownOrder) {
      const info = markdown[fileName];
      if (info?.statusLine) statusCandidates.push({ source: fileName, line: info.statusLine, updatedAt: info.mtime || null });
    }
  }

  let completionSource = null;
  let completionUpdatedAt = null;

  for (const candidate of statusCandidates) {
    const normalized = normalizeCompletion(candidate.line);
    if (normalized) {
      completionState = normalized;
      completionEvidence.push(`${candidate.source}: explicit status line "${candidate.line}"`);
      completionSource = candidate.source;
      completionUpdatedAt = candidate.updatedAt;
      break;
    }
  }

  return {
    activityState,
    completionState,
    activityScoreHours: ageHours,
    lastActivityIso: freshest === null ? null : new Date(freshest).toISOString(),
    activityEvidence,
    completionEvidence,
    completionSource,
    completionUpdatedAt,
  };
}
