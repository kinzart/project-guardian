import path from 'node:path';
import { loadConfig } from '../../config/loadConfig.js';
import { createStore } from '../../store/createStore.js';
import { runScan } from '../../discovery/scanner.js';
import { renderInventory } from '../../report/inventory.js';
import { renderProjectStatus } from '../../report/status.js';
import { runIntelligence } from '../../intelligence/runner.js';
import { ScanLogger } from '../../util/logger.js';

export async function scanCommand({ projectRoot, store: suppliedStore = null, config: suppliedConfig = null }) {
  const configPath = path.join(projectRoot, 'guardian.config.json');
  const config = suppliedConfig || loadConfig(configPath);

  const created = suppliedStore ? { store: suppliedStore, backend: 'shared-runtime' } : await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const { store, backend } = created;
  const scanId = Date.now().toString(36);
  const logger = new ScanLogger(path.join(projectRoot, 'logs'), scanId);

  logger.info('scan starting', { backend, roots: config.scanRoots });
  console.log(`Guardian scan starting (store backend: ${backend})`);
  console.log(`Roots: ${config.scanRoots.join(', ') || '(none configured)'}`);

  // Pass 1 — discovery (V0.1/V0.1.1, unchanged): walk, score, inspect, classify, persist.
  const scan = await runScan({ config, store, logger, roots: config.scanRoots });

  // Pass 2 — intelligence (V0.2): reads what discovery just found, never re-walks the
  // filesystem. Reuses a project's stored snapshot when its known sources haven't changed.
  const projects = await store.listProjects();
  const intelligence = await runIntelligence({ store, projects });

  const inventoryReport = await renderInventory({
    store,
    reportsDir: path.join(projectRoot, 'reports'),
    lastScan: scan,
  });
  const statusReport = await renderProjectStatus({
    store,
    reportsDir: path.join(projectRoot, 'reports'),
    lastScan: scan,
  });

  if (!suppliedStore) await store.close();

  const nestedCount = projects.filter((p) => p.nested_candidate).length;
  const familyCount = new Set(projects.filter((p) => p.project_family).map((p) => p.project_family)).size;
  const familyMemberCount = projects.filter((p) => p.project_family).length;

  console.log(`Candidates detected: ${scan.projects_found} (unchanged: ${scan.projects_unchanged}, processed: ${scan.projects_processed}, pruned: ${scan.projects_pruned})`);
  console.log(`Inventory projects: ${projects.length}`);
  console.log(`Nested candidates: ${nestedCount} | Project families: ${familyCount} (${familyMemberCount} members)`);
  console.log(`Errors: ${scan.errors}`);
  console.log(`Duration: ${scan.duration_ms}ms`);
  console.log(`Intelligence — reused: ${intelligence.reused}, recomputed: ${intelligence.recomputed}, without sufficient context: ${intelligence.withoutSufficientContext}`);
  console.log(`Inventory: ${inventoryReport.inventoryPath}`);
  console.log(`Status: ${statusReport.statusPath}`);
  console.log(`JSON: ${inventoryReport.jsonPath}`);

  return { scan, intelligence: { reused: intelligence.reused, recomputed: intelligence.recomputed, withoutSufficientContext: intelligence.withoutSufficientContext } };
}
