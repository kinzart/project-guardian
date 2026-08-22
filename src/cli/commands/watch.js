import path from 'node:path';
import { loadConfig } from '../../config/loadConfig.js';
import { createStore } from '../../store/createStore.js';
import { Watcher } from '../../watch/watcher.js';

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}

function findProjects(projects, query) {
  return projects.filter(
    (p) => p.root_path === query || p.name.toLowerCase() === query.toLowerCase() || p.name.toLowerCase().includes(query.toLowerCase()),
  );
}

// `guardian watch` — foreground live filesystem observer over the current inventory. See
// SPEC_V0.3.md. Never watches an unbounded path (only already-known project roots), never
// writes into a watched project, and stops cleanly on SIGINT/SIGTERM.
export async function watchCommand({ projectRoot, args }) {
  const projectIdx = args.indexOf('--project');
  const projectFilter = projectIdx !== -1 ? args[projectIdx + 1] : null;

  const configPath = path.join(projectRoot, 'guardian.config.json');
  const config = loadConfig(configPath, { autoDetectRoots: false });

  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));

  let projects = await store.listProjects();
  if (projectFilter) {
    projects = findProjects(projects, projectFilter);
    if (projects.length === 0) {
      console.error(`No project matching "${projectFilter}" found. Run \`guardian list\`.`);
      await store.close();
      process.exitCode = 1;
      return;
    }
  }
  if (projects.length === 0) {
    console.log('No projects in the inventory to watch. Run `guardian scan` first.');
    await store.close();
    return;
  }

  const guardianSelfPaths = [path.join(projectRoot, 'data'), path.join(projectRoot, 'reports'), path.join(projectRoot, 'logs')];
  const watcher = new Watcher({ store, config, reportsDir: path.join(projectRoot, 'reports'), guardianSelfPaths });

  console.log('Project Guardian Watcher');
  console.log('');
  console.log(`Watching: ${projects.length} project${projects.length === 1 ? '' : 's'}`);
  console.log('');

  watcher.onEvent((evt) => {
    if (evt.type === 'refresh') {
      const changedWhat = evt.batch.paths.length === 1 ? path.basename(evt.batch.paths[0]) : `${evt.batch.paths.length} files changed`;
      console.log(`${fmtTime(evt.at)} ${evt.project.name}`);
      console.log(`         ${changedWhat}`);
      console.log(`         ${evt.intelligenceRecomputed ? 'intelligence refreshed' : 'activity refreshed'}`);
    } else if (evt.type === 'watch-error') {
      console.log(`${fmtTime(evt.at)} ${evt.project.name}`);
      console.log(`         watch error (${evt.status}): ${evt.error.message}`);
    } else if (evt.type === 'root-available') {
      console.log(`${fmtTime(evt.at)} ${evt.project.name}`);
      console.log('         root available again');
    } else if (evt.type === 'protected') {
      console.log(`${fmtTime(evt.at)} protected source changed (not read, not logged by name)`);
    } else if (evt.type === 'error') {
      console.log(`${fmtTime(evt.at)} error: ${evt.error.message}`);
    }
  });

  await watcher.start(projects);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('');
    console.log('Ctrl+C');
    console.log('         stopping...');
    await watcher.stop('STOPPED');
    await store.close();
    console.log('         watcher stopped cleanly');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {}); // foreground: block until a signal handler calls process.exit
}
