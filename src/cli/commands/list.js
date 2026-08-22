import path from 'node:path';
import { createStore } from '../../store/createStore.js';

export async function listCommand({ projectRoot }) {
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const projects = await store.listProjects();
  await store.close();

  if (projects.length === 0) {
    console.log('No projects in the store yet. Run `guardian scan` first.');
    return projects;
  }

  console.log(`${'NAME'.padEnd(30)} ${'ACTIVITY'.padEnd(10)} ${'COMPLETION'.padEnd(14)} ${'CONF'.padEnd(6)} PATH`);
  for (const p of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(
      `${p.name.slice(0, 30).padEnd(30)} ${p.status.activity_state.padEnd(10)} ${p.status.completion_state.padEnd(14)} ${p.confidence.padEnd(6)} ${p.root_path}`,
    );
  }
  return projects;
}
