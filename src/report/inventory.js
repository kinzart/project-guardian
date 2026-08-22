import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SECTION_ORDER = ['ACTIVE', 'WARM', 'STALE', 'DORMANT'];
const COMPLETION_STATES = ['UNKNOWN', 'PLANNING', 'IN_PROGRESS', 'BLOCKED', 'PARTIAL', 'DONE', 'ARCHIVED'];

function renderProject(p) {
  const lines = [];
  lines.push(`### ${p.name}`);
  lines.push('');
  lines.push(`Path: ${p.root_path}`);
  lines.push(`Confidence: ${p.confidence}`);
  lines.push(`Activity: ${p.status.activity_state}`);
  lines.push(`Completion: ${p.status.completion_state}`);
  if (p.completion_detail?.source) {
    lines.push(`Completion source: ${p.completion_detail.source}`);
    lines.push(`Completion evidence: ${p.completion_detail.evidence}`);
    lines.push(`Completion updated: ${p.completion_detail.updated_at || 'unknown'}`);
  }
  lines.push(`AUM: ${p.has_aum ? 'yes' : 'no'}`);
  lines.push(`Git: ${p.has_git ? 'yes' : 'no'}`);
  lines.push(`Last activity: ${p.status_confidence.activity_evidence[0] || 'unknown'}`);
  if (p.project_family) {
    if (p.is_canonical) {
      const relatedCount = p.related_roots?.length || 0;
      lines.push(`Family: "${p.project_family}" — canonical, ${relatedCount} related root(s)`);
    } else {
      lines.push(`Family: "${p.project_family}" — related to canonical project (relation: ${p.relation_type})`);
    }
  }
  if (p.nested_candidate) {
    lines.push(`⚠ Nested candidate: path hint "${p.path_relation_hint}", no .git/.memory — verify manually before treating as independent`);
  }
  if (p.errors?.length) {
    lines.push(`Errors: ${p.errors.length}`);
  }
  lines.push('Evidence:');
  for (const e of p.status_confidence.activity_evidence.slice(0, 5)) {
    lines.push(`- ${e}`);
  }
  for (const e of p.status_confidence.completion_evidence) {
    lines.push(`- ${e}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function renderInventory({ store, reportsDir, lastScan }) {
  mkdirSync(reportsDir, { recursive: true });
  const projects = await store.listProjects();

  const grouped = { ACTIVE: [], WARM: [], STALE: [], DORMANT: [] };
  for (const p of projects) {
    (grouped[p.status.activity_state] || grouped.DORMANT).push(p);
  }
  for (const key of SECTION_ORDER) {
    grouped[key].sort((a, b) => a.name.localeCompare(b.name));
  }

  const md = [];
  md.push('# Project Guardian — Inventory');
  md.push('');
  md.push(`Último scan: ${lastScan ? lastScan.finished_at : 'never'}`);
  md.push('');
  md.push(`Total detectado: ${projects.length}`);
  md.push('');

  // Computed from the exact same `projects` array the sections below iterate, so the summary
  // counts and the per-project rows can never disagree with each other.
  const completionCounts = Object.fromEntries(COMPLETION_STATES.map((s) => [s, 0]));
  for (const p of projects) {
    completionCounts[p.status.completion_state] = (completionCounts[p.status.completion_state] || 0) + 1;
  }
  const familyCount = new Set(projects.filter((p) => p.project_family).map((p) => p.project_family)).size;
  const nestedCount = projects.filter((p) => p.nested_candidate).length;

  md.push('## Summary');
  md.push('');
  md.push(`Activity: ${SECTION_ORDER.map((s) => `${s} ${grouped[s].length}`).join(' · ')}`);
  md.push(`Completion: ${COMPLETION_STATES.map((s) => `${s} ${completionCounts[s]}`).join(' · ')}`);
  md.push(`Project families detected: ${familyCount}`);
  md.push(`Nested/low-confidence candidates: ${nestedCount}`);
  md.push('');

  for (const section of SECTION_ORDER) {
    md.push(`## ${section}`);
    md.push('');
    if (grouped[section].length === 0) {
      md.push('_none_');
      md.push('');
      continue;
    }
    for (const p of grouped[section]) {
      md.push(renderProject(p));
    }
  }

  const inventoryPath = path.join(reportsDir, 'PROJECT_INVENTORY.md');
  writeFileSync(inventoryPath, md.join('\n'));

  // V0.2: enrich the machine-readable dump with intelligence snapshots + family rollups when
  // the store has them (a store that only ever ran V0.1 discovery simply has none yet).
  const intelligence = typeof store.listIntelligence === 'function' ? await store.listIntelligence() : [];
  const familyRollups = typeof store.listFamilyRollups === 'function' ? await store.listFamilyRollups() : [];

  const jsonPath = path.join(reportsDir, 'projects.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), lastScan, projects, intelligence, familyRollups }, null, 2));

  return { inventoryPath, jsonPath, totalProjects: projects.length };
}
