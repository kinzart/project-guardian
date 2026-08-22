// Renders reports/PROJECT_STATUS.md — the human-facing V0.2 intelligence report. Where
// PROJECT_INVENTORY.md (V0.1) answers "what projects exist?", this answers "where did I leave
// off, and what's next?" for each of them. Every claim shown here traces back to the same
// evidence-tagged fields in the store (see src/intelligence/snapshot.js) — nothing here is
// invented at render time.

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SECTION_ORDER = ['ACTIVE', 'WARM', 'STALE', 'DORMANT'];

function short(text, max = 140) {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderOneProjectStatus(p, snapshot) {
  const lines = [];
  lines.push(`### ${p.name}`);
  lines.push('');
  lines.push(`Path: ${p.root_path}`);
  lines.push(`Completion: ${p.status.completion_state}`);
  lines.push(`Activity: ${p.status.activity_state}`);

  if (!snapshot) {
    lines.push('Intelligence: not yet computed for this project.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`Current focus: ${short(snapshot.current_focus.value) || 'UNKNOWN'} (confidence: ${snapshot.current_focus.confidence})`);

  if (snapshot.next_steps.length) {
    lines.push('Next steps:');
    for (const s of snapshot.next_steps.slice(0, 5)) lines.push(`- [${s.confidence}] ${short(s.text)}`);
  } else {
    lines.push('Next steps: none detected');
  }

  if (snapshot.blockers.length) {
    lines.push('Blockers:');
    for (const b of snapshot.blockers.slice(0, 5)) lines.push(`- [${b.confidence}] ${short(b.text)}`);
  } else {
    lines.push('Blockers: none detected');
  }

  if (snapshot.recent_decisions.length) {
    lines.push('Recent decisions:');
    for (const d of snapshot.recent_decisions.slice(0, 5)) lines.push(`- [${d.confidence}] ${short(d.text)}`);
  }

  if (snapshot.conflicts.length) {
    lines.push('⚠ Conflicts:');
    for (const c of snapshot.conflicts) lines.push(`- ${c.field}: ${c.source_a} vs ${c.source_b} — ${c.explanation}`);
  }

  if (p.project_family) {
    lines.push(`Family: "${p.project_family}"${p.is_canonical ? ' (canonical)' : ` (${p.relation_type})`}`);
  }

  lines.push('');
  return lines.join('\n');
}

function renderFamilyRollups(rollups) {
  if (!rollups.length) return [];
  const lines = ['## Project Families', ''];
  for (const r of rollups) {
    lines.push(`### "${r.project_family}" (${r.member_count} members)`);
    if (r.current_member) {
      lines.push(`Current member: ${r.current_member.path} — ${r.rationale} (confidence: ${r.confidence})`);
    } else {
      lines.push('Current member: UNKNOWN — not enough evidence to distinguish an active variant');
    }
    for (const m of r.other_members) {
      lines.push(`- other: ${m.path} (${m.activity_state}, ${m.relation_type})`);
    }
    lines.push('');
  }
  return lines;
}

export async function renderProjectStatus({ store, reportsDir, lastScan }) {
  mkdirSync(reportsDir, { recursive: true });
  const projects = await store.listProjects();
  const intelligenceList = await store.listIntelligence();
  const rollups = await store.listFamilyRollups();
  const byProjectId = new Map(intelligenceList.map((s) => [s.project_id, s]));

  const grouped = { ACTIVE: [], WARM: [], STALE: [], DORMANT: [] };
  for (const p of projects) (grouped[p.status.activity_state] || grouped.DORMANT).push(p);
  for (const key of SECTION_ORDER) grouped[key].sort((a, b) => a.name.localeCompare(b.name));

  const md = [];
  md.push('# Project Guardian — Status');
  md.push('');
  md.push(`Último scan: ${lastScan ? lastScan.finished_at : 'never'}`);
  md.push('');
  md.push(...renderFamilyRollups(rollups));

  for (const section of SECTION_ORDER) {
    md.push(`## ${section}`);
    md.push('');
    if (grouped[section].length === 0) {
      md.push('_none_');
      md.push('');
      continue;
    }
    for (const p of grouped[section]) {
      md.push(renderOneProjectStatus(p, byProjectId.get(p.id)));
    }
  }

  const statusPath = path.join(reportsDir, 'PROJECT_STATUS.md');
  writeFileSync(statusPath, md.join('\n'));
  return { statusPath };
}
