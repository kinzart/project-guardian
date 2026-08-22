import path from 'node:path';
import { createStore } from '../../store/createStore.js';

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseSince(sinceArg) {
  if (!sinceArg) return null;
  const m = sinceArg.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!m) return null;
  return new Date(Date.now() - Number(m[1]) * UNIT_MS[m[2]]).toISOString();
}

function parseArgs(args) {
  let project = null;
  let since = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--project') project = args[i + 1];
    if (args[i] === '--since') since = args[i + 1];
  }
  return { project, since };
}

// `guardian events [--project <name>] [--since <1h|30m|...>]` — reads the operational watch
// event log (metadata/provenance only, never full file content — see SPEC_V0.3.md).
export async function eventsCommand({ projectRoot, args }) {
  const { project: projectFilter, since: sinceArg } = parseArgs(args);

  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));

  let projectId;
  if (projectFilter) {
    const projects = await store.listProjects();
    const project = projects.find(
      (p) => p.root_path === projectFilter || p.name.toLowerCase() === projectFilter.toLowerCase() || p.name.toLowerCase().includes(projectFilter.toLowerCase()),
    );
    if (!project) {
      console.error(`No project matching "${projectFilter}" found.`);
      await store.close();
      process.exitCode = 1;
      return null;
    }
    projectId = project.id;
  }

  const sinceIso = parseSince(sinceArg);
  const events = await store.listWatchEvents({ projectId, sinceIso });
  await store.close();

  if (events.length === 0) {
    console.log(`No watch events recorded${projectFilter ? ` for "${projectFilter}"` : ''}${sinceArg ? ` in the last ${sinceArg}` : ''}.`);
    return events;
  }

  for (const e of events) {
    console.log(
      `${e.occurred_at}  ${e.event_type.padEnd(24)} project=${e.project_root || 'n/a'}  paths=${e.paths.length}  raw=${e.raw_event_count}  intelligence_recomputed=${e.intelligence_recomputed}`,
    );
  }
  return events;
}
