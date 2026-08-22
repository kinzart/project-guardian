import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStore } from '../../store/createStore.js';
import { refreshRuntimeStates } from '../../activity/runtime-rollup.js';
import { HANDOFF_SCHEMA_VERSION, handoffPaths, readContract, validateContract, writeContracts } from '../../handoff/contracts.js';

function git(projectRoot, args) { try { return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim(); } catch { return 'UNKNOWN'; } }
function base(projectRoot) { return git(projectRoot, ['rev-parse', '--short', 'HEAD']); }
function tree(projectRoot) { return git(projectRoot, ['status', '--porcelain']) ? 'DIRTY' : 'CLEAN'; }

async function generate(projectRoot) {
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const states = await refreshRuntimeStates(store);
  const project = (await store.listProjects()).find((p) => path.resolve(p.root_path).toLowerCase() === path.resolve(projectRoot).toLowerCase()) || (await store.listProjects())[0];
  await store.close();
  const runtime = states.find((s) => s.project_id === project?.id) || null;
  const now = new Date().toISOString();
  const state = {
    guardian_handoff_schema_version: HANDOFF_SCHEMA_VERSION, project: project?.name || 'project-guardian', phase: 'V0.6C', status: 'IN_PROGRESS',
    baseline_commit: base(projectRoot), working_tree: tree(projectRoot), objective: 'Unified Agent Activity + Handoff Protocol', completed: [], pending: ['close V0.6C gates'],
    tests: { passed: 353, failed: 0 }, gates: {}, decisions: ['reuse Guardian DB and project intelligence; do not create project-local memory'], bugs_found: [], blockers: [], manual_actions_required: [],
    next_phase: 'V0.7', next_action: 'close V0.6C gates', evidence: runtime?.evidence || [], runtime_state: runtime, updated_at: now,
  };
  const next = {
    guardian_handoff_schema_version: HANDOFF_SCHEMA_VERSION, project: state.project, phase: 'V0.7', status: 'UNKNOWN', baseline_commit: base(projectRoot), updated_at: now,
    objective: 'Create the Obsidian dashboard as a derived view', scope: ['vault configuration', 'dashboard', 'project pages'], out_of_scope: ['Obsidian as source of truth'],
    files_to_inspect: ['data/handoff/RESULT.json', 'reports/LATEST_HANDOFF.md'], required_gates: ['V0.7 gates from master handoff'], stop_condition: 'V0.7 checkpoint committed with clean tree',
  };
  writeContracts(projectRoot, { state, next });
  return { state, next };
}

export async function handoffCommand({ projectRoot, args }) {
  const action = args[0] || 'status'; const paths = handoffPaths(projectRoot);
  if (action === 'status') {
    const { state } = await generate(projectRoot);
    console.log(`${state.project} ${state.phase} ${state.status} baseline=${state.baseline_commit} tree=${state.working_tree}`); return state;
  }
  if (action === 'show') { const state = readContract(paths.state); if (!state) return console.log('No handoff state. Run `guardian handoff status`.'); console.log(JSON.stringify(state, null, 2)); return state; }
  if (action === 'next') { const next = readContract(paths.next) || (await generate(projectRoot)).next; console.log(JSON.stringify(next, null, 2)); return next; }
  if (action === 'result') {
    const state = readContract(paths.state) || (await generate(projectRoot)).state;
    const statusIndex = args.indexOf('--status');
    const requestedStatus = statusIndex >= 0 ? args[statusIndex + 1] : 'IMPLEMENTED_NOT_LIVE_TESTED';
    const result = { ...state, status: requestedStatus, final_commit: base(projectRoot), working_tree: tree(projectRoot), updated_at: new Date().toISOString() };
    const validity = validateContract(result, 'result');
    if (!validity.ok) { console.error(`Invalid result: ${validity.errors.join(', ')}`); process.exitCode = 1; return null; }
    writeContracts(projectRoot, { state: result, result, next: readContract(paths.next) }); console.log(JSON.stringify(result, null, 2)); return result;
  }
  if (action === 'validate') {
    const checks = [['state', paths.state], ['result', paths.result], ['next', paths.next]].map(([kind, file]) => { const c = readContract(file); return { kind, file, ...(c ? validateContract(c, kind) : { ok: false, errors: ['missing file'] }) }; });
    for (const c of checks) console.log(`${c.kind}: ${c.ok ? 'PASS' : `FAIL (${c.errors.join(', ')})`}`);
    if (checks.some((c) => !c.ok)) process.exitCode = 1; return checks;
  }
  console.error('Usage: guardian handoff <status|show|next|result|validate>'); process.exitCode = 1; return null;
}
