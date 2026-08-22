import { JsonFileStore } from './JsonFileStore.js';

// Prefers the native node:sqlite module when the running Node version provides it; otherwise
// falls back to the JSON-file store. Callers only ever see the Store interface.
export async function createStore(dbPath) {
  try {
    const sqliteModule = await import('node:sqlite');
    const { NodeSqliteStore } = await import('./NodeSqliteStore.js');
    const store = new NodeSqliteStore(dbPath, sqliteModule);
    await store.init();
    return { store, backend: 'node:sqlite' };
  } catch {
    const store = new JsonFileStore(`${dbPath}.json`);
    await store.init();
    return { store, backend: 'json-file' };
  }
}
