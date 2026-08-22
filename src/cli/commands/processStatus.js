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

// `guardian process-status` — mirrors `guardian watch-status`'s shape (see
// src/cli/commands/watchStatus.js) for the V0.4 process observer.
export async function processStatusCommand({ projectRoot }) {
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const session = await store.getLatestObserverSession();

  if (!session) {
    console.log('No process observer session has ever run. Use `guardian observe` to start one.');
    await store.close();
    return null;
  }

  let status = session.status;
  if (status === 'RUNNING' && !isPidAlive(session.pid)) status = 'UNCLEAN_END';

  const events = await store.listProcessEvents({ sinceIso: session.started_at });
  const activeSessions = await store.listAgentSessions({ active: true });
  await store.close();

  const live = status === 'RUNNING' || status === 'UNCLEAN_END';
  const eventsReceived = live ? events.length : session.events_received ?? 0;
  const starts = live ? events.filter((e) => e.type === 'PROCESS_STARTED' || e.type === 'ALREADY_RUNNING').length : session.process_starts ?? 0;
  const stops = live ? events.filter((e) => e.type === 'PROCESS_STOPPED').length : session.process_stops ?? 0;

  console.log('Process observer status');
  console.log('------------------------');
  console.log(`Status: ${status}`);
  console.log('Adapter: windows (WMI __InstanceCreationEvent/__InstanceDeletionEvent)');
  console.log(`Started: ${session.started_at}`);
  console.log(`Stopped: ${session.stopped_at || 'n/a'}`);
  console.log(`Events received: ${eventsReceived}`);
  console.log(`Process starts: ${starts}`);
  console.log(`Process stops: ${stops}`);
  console.log(`Active process records: ${events.length}`);
  console.log(`Active agent sessions: ${activeSessions.length}`);
  console.log(`Errors: ${session.errors ?? 0}`);

  return { session, status };
}
