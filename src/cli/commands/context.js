import path from 'node:path';
import { createStore } from '../../store/createStore.js';

function findProject(projects, query) {
  return (
    projects.find((p) => p.root_path === query) ||
    projects.find((p) => p.name.toLowerCase() === query.toLowerCase()) ||
    projects.find((p) => p.name.toLowerCase().includes(query.toLowerCase()))
  );
}

function line(label, value) {
  console.log(`${label}:`);
  console.log(value === null || value === undefined || value === '' ? 'UNKNOWN' : value);
  console.log('');
}

function listOrNone(label, items, render) {
  console.log(`${label}:`);
  if (!items.length) {
    console.log('none detected');
  } else {
    for (const item of items) console.log(`- ${render(item)}`);
  }
  console.log('');
}

// "guardian context <project>" — a human-readable read of "where did I leave off on this?",
// built entirely from the evidence-tagged project_intelligence snapshot already computed by
// `guardian scan`. Never computes anything new; just formats what's in the store.
export async function contextCommand({ projectRoot, args }) {
  const query = args[0];
  if (!query) {
    console.error('Usage: guardian context <project-name-or-path>');
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
  const rollup = project.project_family ? await store.getFamilyRollup(project.project_family) : null;
  await store.close();

  console.log(`PROJECT: ${project.name}`);
  console.log('');
  line('Activity', project.status.activity_state);
  line('Completion', project.status.completion_state);

  if (!snapshot) {
    console.log('No intelligence computed yet for this project — run `guardian scan`.');
    return { project, snapshot: null };
  }

  line('Current focus', snapshot.current_focus.value);
  line('Last meaningful work', snapshot.last_meaningful_work.value ? `${snapshot.last_meaningful_work.value} (${snapshot.last_meaningful_work.at || 'unknown time'})` : null);
  listOrNone('Next steps', snapshot.next_steps, (s) => `[${s.confidence}] ${s.text}`);
  listOrNone('Open tasks', snapshot.open_tasks, (t) => `[${t.confidence}] ${t.text}`);
  listOrNone('Blockers', snapshot.blockers, (b) => `[${b.confidence}] ${b.text}`);
  listOrNone('Recent decisions', snapshot.recent_decisions, (d) => `[${d.confidence}] ${d.text}`);
  listOrNone('Risks', snapshot.risks, (r) => `[${r.confidence}] ${r.text}`);

  if (rollup) {
    console.log('Family:');
    console.log(
      rollup.current_member
        ? `"${rollup.project_family}" — current member: ${rollup.current_member.path} (${rollup.rationale})`
        : `"${rollup.project_family}" — no member distinguished as current yet`,
    );
    console.log('');
  }

  console.log(`Confidence (current focus): ${snapshot.current_focus.confidence}`);
  console.log('');
  listOrNone(
    'Evidence',
    snapshot.current_focus.evidence,
    (e) => `${e.source}${e.timestamp ? ` @ ${e.timestamp}` : ''}: ${e.snippet}`,
  );

  if (snapshot.conflicts.length) {
    console.log('⚠ Conflicts detected — see `guardian explain` for details.');
  }

  return { project, snapshot, rollup };
}
