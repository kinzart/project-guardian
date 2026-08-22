import path from 'node:path';
import { createStore } from '../../store/createStore.js';

function findProject(projects, query) {
  return (
    projects.find((p) => p.root_path === query) ||
    projects.find((p) => p.name.toLowerCase() === query.toLowerCase()) ||
    projects.find((p) => p.name.toLowerCase().includes(query.toLowerCase()))
  );
}

function printField(name, f) {
  console.log(`${name}: ${f.value === null ? 'UNKNOWN' : f.value} (confidence: ${f.confidence})`);
  if (f.evidence.length === 0) {
    console.log('  no evidence');
  } else {
    for (const e of f.evidence) console.log(`  - ${e.source}${e.timestamp ? ` @ ${e.timestamp}` : ''}: ${e.snippet}`);
  }
  console.log('');
}

function printList(name, items) {
  console.log(`${name}:`);
  if (!items.length) {
    console.log('  none');
  } else {
    for (const item of items) {
      console.log(`  - ${item.text}${item.status ? ` [${item.status}]` : ''} (confidence: ${item.confidence})`);
      for (const e of item.evidence) console.log(`      ${e.source}${e.timestamp ? ` @ ${e.timestamp}` : ''}: ${e.snippet}`);
    }
  }
  console.log('');
}

// "guardian explain <project>" — answers "why does Guardian think this?": every field's full
// evidence trail plus any recorded conflicts between sources. Never resolves a conflict here,
// only surfaces it (see src/intelligence/snapshot.js detectConflicts).
export async function explainCommand({ projectRoot, args }) {
  const query = args[0];
  if (!query) {
    console.error('Usage: guardian explain <project-name-or-path>');
    process.exitCode = 1;
    return null;
  }

  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const projects = await store.listProjects();
  const project = findProject(projects, query);

  if (!project) {
    console.error(`No project matching "${query}" found. Run \`guardian list\`.`);
    await store.close();
    process.exitCode = 1;
    return null;
  }

  const snapshot = await store.getIntelligence(project.id);
  await store.close();

  console.log(`EXPLAIN: ${project.name}`);
  console.log('');
  console.log(`Completion state: ${project.status.completion_state}`);
  if (project.completion_detail?.source) {
    console.log(`  source: ${project.completion_detail.source}`);
    console.log(`  evidence: ${project.completion_detail.evidence}`);
    console.log(`  updated: ${project.completion_detail.updated_at || 'unknown'}`);
  } else {
    console.log('  no explicit status found in any known source — defaults to UNKNOWN, never inferred from recency');
  }
  console.log('');

  if (!snapshot) {
    console.log('No intelligence computed yet for this project — run `guardian scan`.');
    return { project, snapshot: null };
  }

  printField('current_focus', snapshot.current_focus);
  printField('last_meaningful_work', { value: snapshot.last_meaningful_work.value, confidence: snapshot.last_meaningful_work.confidence, evidence: snapshot.last_meaningful_work.evidence });
  printList('next_steps', snapshot.next_steps);
  printList('blockers', snapshot.blockers);
  printList('recent_decisions', snapshot.recent_decisions);

  console.log('conflicts:');
  if (!snapshot.conflicts.length) {
    console.log('  none');
  } else {
    for (const c of snapshot.conflicts) {
      console.log(`  - field: ${c.field}`);
      console.log(`    source_a: ${c.source_a}`);
      console.log(`    source_b: ${c.source_b}`);
      console.log(`    explanation: ${c.explanation}`);
    }
  }
  console.log('');

  console.log('source_health:', JSON.stringify(snapshot.source_health));

  return { project, snapshot };
}
