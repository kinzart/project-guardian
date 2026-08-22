import path from 'node:path';
import { createStore } from '../../store/createStore.js';

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function watchStatusCommand({ projectRoot }) {
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const session = await store.getLatestWatchSession();

  if (!session) {
    console.log('No watch session has ever run. Use `guardian watch` to start one.');
    await store.close();
    return null;
  }

  // A session recorded RUNNING whose process is no longer alive means Guardian never got to
  // record a clean STOPPED — a crash, not a clean exit. Report it as such without inventing a
  // cause (see SPEC_V0.3.md "Watch session").
  let status = session.status;
  if (status === 'RUNNING' && !isPidAlive(session.pid)) status = 'UNCLEAN_END';

  const sessionEvents = await store.listWatchEvents({ sinceIso: session.started_at });
  const lastEvent = sessionEvents.length ? sessionEvents[sessionEvents.length - 1] : null;
  await store.close();

  // A still-RUNNING session's own counters are only finalized on stop() — while it's live, or
  // when the process ended uncleanly and never got to finalize them, derive current numbers
  // from the persisted event log (which is itself authoritative) instead of showing stale
  // zeros. Only a cleanly-STOPPED session's own recorded totals are trusted as-is.
  const live = status === 'RUNNING' || status === 'UNCLEAN_END';
  const eventsReceived = live ? sessionEvents.reduce((sum, e) => sum + (e.raw_event_count || 0), 0) : session.events_received ?? 0;
  const eventsCoalesced = live ? sessionEvents.length : session.events_coalesced ?? 0;
  const refreshes = live ? sessionEvents.filter((e) => e.event_type === 'PROJECT_SOURCE_CHANGED').length : session.refreshes ?? 0;

  console.log('Watch status');
  console.log('------------');
  console.log(`Status: ${status}`);
  console.log(`Started: ${session.started_at}`);
  console.log(`Stopped: ${session.stopped_at || 'n/a'}`);
  console.log(`Projects watched: ${session.projects_watched}`);
  console.log('Watch targets:');
  for (const p of session.watched_paths || []) console.log(`  - ${p}`);
  console.log(`Events received: ${eventsReceived}`);
  console.log(`Events coalesced: ${eventsCoalesced}`);
  console.log(`Refreshes: ${refreshes}`);
  console.log(`Errors: ${session.errors ?? 0}`);
  console.log(`Last event: ${lastEvent ? `${lastEvent.occurred_at} ${lastEvent.event_type} (${lastEvent.project_root || 'n/a'})` : 'none'}`);

  return { session, status };
}
