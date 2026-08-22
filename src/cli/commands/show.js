import path from 'node:path';
import { createStore } from '../../store/createStore.js';

export async function showCommand({ projectRoot, args }) {
  const query = args[0];
  if (!query) {
    console.error('Usage: guardian show <project-name-or-path>');
    process.exitCode = 1;
    return null;
  }

  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const projects = await store.listProjects();
  const project =
    projects.find((p) => p.root_path === query) ||
    projects.find((p) => p.name.toLowerCase() === query.toLowerCase()) ||
    projects.find((p) => p.name.toLowerCase().includes(query.toLowerCase()));

  if (!project) {
    console.error(`No project matching "${query}" found. Run \`guardian list\`.`);
    await store.close();
    process.exitCode = 1;
    return null;
  }

  const sources = await store.listSourcesForProject(project.id);
  const observations = await store.listObservationsForProject(project.id);
  const intelligence = await store.getIntelligence(project.id);
  const familyRollup = project.project_family ? await store.getFamilyRollup(project.project_family) : null;
  await store.close();

  console.log(JSON.stringify({ project, sources, observations, intelligence, familyRollup }, null, 2));
  return { project, sources, observations, intelligence, familyRollup };
}
