// Family-level intelligence rollup (see SPEC_V0.2.md "Project families"). Never merges the
// members' filesystems or data — this only picks out, with recorded evidence, which member of
// an already-detected project_family (src/discovery/family.js) currently looks active, so a
// human doesn't have to open four folders to find the one that matters.

const ACTIVITY_RANK = { ACTIVE: 3, WARM: 2, STALE: 1, DORMANT: 0 };

function extractVersionNumber(rootPath) {
  const m = rootPath.match(/[-_ ]v(\d+)\b/i);
  return m ? parseInt(m[1], 10) : 0;
}

// members: [{ project, snapshot }] — every project record sharing one project_family.
export function buildFamilyRollup(familyKey, members) {
  const ranked = [...members].sort((a, b) => {
    const activityDelta = (ACTIVITY_RANK[b.project.status.activity_state] || 0) - (ACTIVITY_RANK[a.project.status.activity_state] || 0);
    if (activityDelta !== 0) return activityDelta;
    return extractVersionNumber(b.project.root_path) - extractVersionNumber(a.project.root_path);
  });

  const top = ranked[0];
  const hasEvidence = !!top && (ACTIVITY_RANK[top.project.status.activity_state] || 0) > 0;

  return {
    project_family: familyKey,
    current_member: hasEvidence
      ? { id: top.project.id, path: top.project.root_path, relation_type: top.project.relation_type }
      : null,
    confidence: hasEvidence ? (top.project.is_canonical ? 'MEDIUM' : 'LOW') : 'UNKNOWN',
    rationale: hasEvidence
      ? `most recently active member (activity_state=${top.project.status.activity_state}), path hint "${top.project.relation_type}"`
      : null,
    evidence: hasEvidence
      ? [{ source: 'activity_state', snippet: top.project.status.activity_state, timestamp: top.project.last_seen }]
      : [],
    other_members: members
      .filter((m) => m !== top)
      .map((m) => ({ id: m.project.id, path: m.project.root_path, relation_type: m.project.relation_type, activity_state: m.project.status.activity_state })),
    member_count: members.length,
  };
}
