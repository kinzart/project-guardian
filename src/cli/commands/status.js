import path from 'node:path';
import { createStore } from '../../store/createStore.js';

// Metric names are deliberately explicit (not a bare "projects detected") — see
// SPEC_V0.2.md "Métricas claras". Everything here is computed live from the current store
// contents, the same principle as the V0.1.1 report-consistency fix: a status summary must
// never be able to disagree with the data it's summarizing.
export async function statusCommand({ projectRoot }) {
  const { store, backend } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const projects = await store.listProjects();
  const intelligenceList = typeof store.listIntelligence === 'function' ? await store.listIntelligence() : [];
  const lastScan = await store.getLastScan();
  await store.close();

  const counts = { ACTIVE: 0, WARM: 0, STALE: 0, DORMANT: 0 };
  for (const p of projects) counts[p.status.activity_state] = (counts[p.status.activity_state] || 0) + 1;

  const completionCounts = { UNKNOWN: 0, PLANNING: 0, IN_PROGRESS: 0, BLOCKED: 0, PARTIAL: 0, DONE: 0, ARCHIVED: 0 };
  for (const p of projects) completionCounts[p.status.completion_state] = (completionCounts[p.status.completion_state] || 0) + 1;

  const nestedCandidates = projects.filter((p) => p.nested_candidate).length;
  const familySet = new Set(projects.filter((p) => p.project_family).map((p) => p.project_family));
  const familyMembers = projects.filter((p) => p.project_family).length;

  const hasNoContext = (s) => s.source_health.aum === 'none' && s.source_health.docs === 'none' && s.source_health.git === 'none';
  const withoutSufficientContext = intelligenceList.filter(hasNoContext).length;

  console.log(`Store backend: ${backend}`);
  console.log(`Inventory projects: ${projects.length}`);
  console.log(`  ACTIVE: ${counts.ACTIVE}  WARM: ${counts.WARM}  STALE: ${counts.STALE}  DORMANT: ${counts.DORMANT}`);
  console.log(
    `  DONE: ${completionCounts.DONE}  IN_PROGRESS: ${completionCounts.IN_PROGRESS}  BLOCKED: ${completionCounts.BLOCKED}  PARTIAL: ${completionCounts.PARTIAL}  PLANNING: ${completionCounts.PLANNING}  ARCHIVED: ${completionCounts.ARCHIVED}  UNKNOWN: ${completionCounts.UNKNOWN}`,
  );
  console.log(`Nested candidates: ${nestedCandidates}`);
  console.log(`Project families: ${familySet.size} (${familyMembers} members)`);
  console.log(`Projects with intelligence: ${intelligenceList.length}`);
  console.log(`Projects without sufficient context: ${withoutSufficientContext}`);
  if (lastScan) {
    console.log(
      `Last scan: ${lastScan.finished_at} (candidates detected: ${lastScan.projects_found}, unchanged: ${lastScan.projects_unchanged}, pruned: ${lastScan.projects_pruned || 0}, errors: ${lastScan.errors}, ${lastScan.duration_ms}ms)`,
    );
  } else {
    console.log('Last scan: never');
  }

  return { projects, lastScan };
}
