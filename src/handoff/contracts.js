import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const HANDOFF_SCHEMA_VERSION = 1;
export const VALID_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED', 'UNKNOWN', 'NOT_APPLICABLE', 'ENVIRONMENT_BLOCKED', 'IMPLEMENTED_NOT_LIVE_TESTED', 'IN_PROGRESS']);

export function handoffPaths(projectRoot) {
  const dir = path.join(projectRoot, 'data', 'handoff');
  const reports = path.join(projectRoot, 'reports');
  return { dir, reports, state: path.join(dir, 'CURRENT_STATE.json'), result: path.join(dir, 'RESULT.json'), next: path.join(dir, 'NEXT_TASK.json'), latestMd: path.join(reports, 'LATEST_HANDOFF.md'), nextMd: path.join(reports, 'NEXT_TASK.md') };
}

export function validateContract(contract, kind = 'state') {
  const errors = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return { ok: false, errors: ['contract must be an object'] };
  if (contract.guardian_handoff_schema_version !== HANDOFF_SCHEMA_VERSION) errors.push(`guardian_handoff_schema_version must be ${HANDOFF_SCHEMA_VERSION}`);
  for (const key of ['project', 'phase', 'status', 'baseline_commit', 'updated_at']) if (!contract[key]) errors.push(`missing ${key}`);
  if (contract.status && !VALID_STATUSES.has(contract.status)) errors.push(`invalid status: ${contract.status}`);
  if (kind === 'next') for (const key of ['objective', 'scope', 'out_of_scope', 'required_gates', 'stop_condition']) if (contract[key] === undefined) errors.push(`missing ${key}`);
  return { ok: errors.length === 0, errors };
}

export function writeContracts(projectRoot, { state, result, next }) {
  const paths = handoffPaths(projectRoot);
  mkdirSync(paths.dir, { recursive: true }); mkdirSync(paths.reports, { recursive: true });
  if (state) writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);
  if (result) writeFileSync(paths.result, `${JSON.stringify(result, null, 2)}\n`);
  if (next) writeFileSync(paths.next, `${JSON.stringify(next, null, 2)}\n`);
  if (state) writeFileSync(paths.latestMd, renderLatest(state));
  if (next) writeFileSync(paths.nextMd, renderNext(next));
  return paths;
}

export function readContract(file) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }

export function renderLatest(s) {
  return `# Latest Handoff\n\n- Project: ${s.project}\n- Phase: ${s.phase}\n- Status: ${s.status}\n- Baseline: ${s.baseline_commit}\n- Working tree: ${s.working_tree}\n- Objective: ${s.objective || 'UNKNOWN'}\n- Completed: ${(s.completed || []).join('; ') || 'none'}\n- Bugs: ${(s.bugs_found || []).join('; ') || 'none'}\n- Gates: ${summarizeGates(s.gates)}\n- Next: ${s.next_action || 'UNKNOWN'}\n- Updated: ${s.updated_at}\n`;
}

export function renderNext(n) {
  return `# Next Task\n\n- Phase: ${n.phase}\n- Objective: ${n.objective}\n- Baseline: ${n.baseline_commit}\n- Scope: ${(n.scope || []).join('; ')}\n- Out of scope: ${(n.out_of_scope || []).join('; ')}\n- Required gates: ${(n.required_gates || []).join('; ')}\n- Stop condition: ${n.stop_condition}\n`;
}

function summarizeGates(gates = {}) { return Object.entries(gates).map(([k, v]) => `${k}=${typeof v === 'string' ? v : v.status}`).join(', ') || 'none'; }
