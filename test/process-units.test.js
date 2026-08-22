import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCommandMetadata, sanitizeExecutablePath } from '../src/process/sanitizer.js';
import { classifyProcess } from '../src/process/classifier.js';
import { normalizeProcessEvent } from '../src/process/normalizer.js';
import { ProcessTree } from '../src/process/process-tree.js';
import { correlateProject } from '../src/process/project-correlator.js';
import { CONFIDENCE } from '../src/intelligence/field.js';

// --- sanitizer ---------------------------------------------------------

test('sanitizer: strips values of sensitive flags, never returns raw command line', () => {
  const meta = sanitizeCommandMetadata('node app.js --api-key SECRET123 --token SECRET456 --password SECRET789', 'sanitized-minimal');
  assert.equal(meta.pathLikeArgs.length, 0);
  assert.equal(meta.redactedCount, 3);
  assert.ok(!('commandLine' in meta));
  assert.ok(!JSON.stringify(meta).includes('SECRET'));
});

test('sanitizer: strips Bearer tokens and known secret-shaped prefixes', () => {
  const meta = sanitizeCommandMetadata('curl -H "Authorization: Bearer SECRET" https://api.example.com', 'sanitized-minimal');
  assert.ok(!JSON.stringify(meta).includes('SECRET'));
  const meta2 = sanitizeCommandMetadata('deploy --key sk-abc123FAKEKEY', 'sanitized-minimal');
  assert.ok(!JSON.stringify(meta2).includes('sk-abc123FAKEKEY'));
});

test('sanitizer: env-style ANTHROPIC_API_KEY=... / OPENAI_API_KEY=... assignments are redacted', () => {
  const meta = sanitizeCommandMetadata('node run.js ANTHROPIC_API_KEY=sk-real-value OPENAI_API_KEY=sk-other', 'sanitized-minimal');
  assert.ok(!JSON.stringify(meta).includes('sk-real-value'));
  assert.ok(!JSON.stringify(meta).includes('sk-other'));
});

test('sanitizer: path-like arguments are preserved for correlation, non-path args are dropped', () => {
  const meta = sanitizeCommandMetadata('node C:\\projects\\demo\\src\\index.js --verbose --port 3000', 'sanitized-minimal');
  assert.deepEqual(meta.pathLikeArgs, ['C:\\projects\\demo\\src\\index.js']);
});

test('sanitizer: mode "none" extracts nothing', () => {
  const meta = sanitizeCommandMetadata('node C:\\projects\\demo\\index.js', 'none');
  assert.deepEqual(meta, { argCount: 0, pathLikeArgs: [], redactedCount: 0 });
});

test('sanitizer: executable path with a secret-shaped segment gets that segment redacted', () => {
  const p = sanitizeExecutablePath('C:\\Users\\dev\\.ssh\\wrapper.exe');
  assert.ok(p.includes('[REDACTED]'));
  assert.ok(!p.includes('.ssh'));
});

// --- classifier ----------------------------------------------------------

test('classifier: known agent binaries classify as AI_AGENT with an identity and evidence', () => {
  const r = classifyProcess('claude.exe', {}, {});
  assert.equal(r.classification, 'AI_AGENT');
  assert.equal(r.agentType, 'CLAUDE_CODE');
  assert.ok(r.evidence.length > 0);

  const r2 = classifyProcess('codex.exe', {}, {});
  assert.equal(r2.agentType, 'CODEX');
});

test('classifier: shells and terminal hosts classify correctly', () => {
  assert.equal(classifyProcess('powershell.exe', {}, {}).classification, 'SHELL');
  assert.equal(classifyProcess('pwsh.exe', {}, {}).classification, 'SHELL');
  assert.equal(classifyProcess('cmd.exe', {}, {}).classification, 'SHELL');
  assert.equal(classifyProcess('WindowsTerminal.exe', {}, {}).classification, 'TERMINAL_HOST');
});

test('classifier: dev runtimes and version control classify correctly', () => {
  assert.equal(classifyProcess('node.exe', {}, {}).classification, 'DEV_RUNTIME');
  assert.equal(classifyProcess('python.exe', {}, {}).classification, 'DEV_RUNTIME');
  assert.equal(classifyProcess('git.exe', {}, {}).classification, 'VERSION_CONTROL');
});

test('classifier: node.exe alone is never inferred as an agent', () => {
  const r = classifyProcess('node.exe', { executablePath: 'C:\\Program Files\\nodejs\\node.exe' }, {});
  assert.equal(r.classification, 'DEV_RUNTIME');
  assert.equal(r.agentType, null);
});

test('classifier: unmatched binaries are OTHER, never guessed', () => {
  const r = classifyProcess('SomeRandomApp.exe', {}, {});
  assert.equal(r.classification, 'OTHER');
  assert.equal(r.agentType, null);
});

test('classifier: config overrides win over defaults', () => {
  const config = { process: { classificationOverrides: [{ pattern: '^myagent\\.exe$', classification: 'AI_AGENT', agentType: 'CUSTOM_AGENT' }] } };
  const r = classifyProcess('myagent.exe', {}, config);
  assert.equal(r.classification, 'AI_AGENT');
  assert.equal(r.agentType, 'CUSTOM_AGENT');
});

// --- normalizer ------------------------------------------------------------

test('normalizer: drops malformed events, carries startTimeKnown correctly', () => {
  assert.equal(normalizeProcessEvent(null), null);
  assert.equal(normalizeProcessEvent({ type: 'PROCESS_STARTED' }), null); // no pid

  const started = normalizeProcessEvent({ type: 'PROCESS_STARTED', pid: 100, timestamp: '2026-01-01T00:00:00.000Z' });
  assert.equal(started.startTimeKnown, true);

  const alreadyKnown = normalizeProcessEvent({ type: 'ALREADY_RUNNING', pid: 100, startTimeKnown: true, timestamp: '2026-01-01T00:00:00.000Z' });
  assert.equal(alreadyKnown.startTimeKnown, true);

  const alreadyUnknown = normalizeProcessEvent({ type: 'ALREADY_RUNNING', pid: 100, timestamp: '2026-01-01T00:00:00.000Z' });
  assert.equal(alreadyUnknown.startTimeKnown, false); // never invents certainty it wasn't given
});

// --- process tree / PID reuse ---------------------------------------------

test('process-tree: parent/child linkage and tree summary', () => {
  const tree = new ProcessTree();
  const shellId = tree.addStart({ pid: 1, parentPid: null, processName: 'powershell.exe', timestamp: 't0' });
  const claudeId = tree.addStart({ pid: 2, parentPid: 1, processName: 'claude.exe', timestamp: 't1' });
  const nodeId = tree.addStart({ pid: 3, parentPid: 2, processName: 'node.exe', timestamp: 't2' });

  assert.equal(tree.get(shellId).childRuntimeIds.has(claudeId), true);
  assert.equal(tree.ancestors(nodeId).length, 2);
  assert.equal(tree.treeSummary(nodeId), 'powershell.exe > claude.exe > node.exe');
});

test('process-tree: PID reuse never confuses two different runtime instances', () => {
  const tree = new ProcessTree();
  const first = tree.addStart({ pid: 500, parentPid: 1, processName: 'node.exe', timestamp: 't0' });
  tree.markStop(500, 't1');
  const second = tree.addStart({ pid: 500, parentPid: 9, processName: 'python.exe', timestamp: 't2' });

  assert.notEqual(first, second);
  assert.equal(tree.getByPid(500).runtimeId, second); // only the currently-alive instance is reachable by pid
  assert.equal(tree.get(first).processName, 'node.exe');
  assert.equal(tree.get(second).processName, 'python.exe');
});

test('process-tree: markStop on an unknown pid is a no-op, never throws', () => {
  const tree = new ProcessTree();
  assert.equal(tree.markStop(99999, 't0'), null);
});

// --- project correlation ---------------------------------------------------

const PROJECTS = [
  { id: 'p1', name: 'PROJECT-GUARDIAN', root_path: 'C:\\dev\\PROJECT-GUARDIAN' },
  { id: 'p2', name: 'ai-universal-memory', root_path: 'C:\\dev\\ai-universal-memory' },
];

test('project-correlator: direct command-line path evidence yields HIGH confidence', () => {
  const tree = new ProcessTree();
  const runtimeId = tree.addStart({ pid: 10, parentPid: null, processName: 'node.exe', timestamp: 't0' });
  const result = correlateProject({
    record: { runtimeId, timestamp: 't0', executablePath: 'C:\\Program Files\\nodejs\\node.exe' },
    commandMetadata: { pathLikeArgs: ['C:\\dev\\PROJECT-GUARDIAN\\src\\cli\\index.js'] },
    tree,
    projects: PROJECTS,
  });
  assert.equal(result.projectId, 'p1');
  assert.equal(result.confidence, CONFIDENCE.HIGH);
  assert.ok(result.evidence.length > 0);
});

test('project-correlator: executable located inside a project root yields HIGH confidence', () => {
  const tree = new ProcessTree();
  const runtimeId = tree.addStart({ pid: 11, parentPid: null, processName: 'claude.exe', timestamp: 't0' });
  const result = correlateProject({
    record: { runtimeId, timestamp: 't0', executablePath: 'C:\\dev\\ai-universal-memory\\node_modules\\.bin\\claude.exe' },
    commandMetadata: { pathLikeArgs: [] },
    tree,
    projects: PROJECTS,
  });
  assert.equal(result.projectId, 'p2');
  assert.equal(result.confidence, CONFIDENCE.HIGH);
});

test('project-correlator: inherited-from-ancestor evidence alone caps at MEDIUM, never HIGH', () => {
  const tree = new ProcessTree();
  const parentId = tree.addStart({ pid: 20, parentPid: null, processName: 'claude.exe', timestamp: 't0' });
  const childId = tree.addStart({ pid: 21, parentPid: 20, processName: 'node.exe', timestamp: 't1' });
  const correlations = new Map([[parentId, { projectId: 'p1', confidence: CONFIDENCE.HIGH, evidence: [] }]]);

  const result = correlateProject({
    record: { runtimeId: childId, timestamp: 't1', executablePath: 'C:\\Program Files\\nodejs\\node.exe' },
    commandMetadata: { pathLikeArgs: [] },
    tree,
    projects: PROJECTS,
    correlations,
  });
  assert.equal(result.projectId, 'p1');
  assert.equal(result.confidence, CONFIDENCE.MEDIUM);
});

test('project-correlator: temporal evidence alone is capped at LOW, never promoted to HIGH or MEDIUM by itself', () => {
  const tree = new ProcessTree();
  const runtimeId = tree.addStart({ pid: 30, parentPid: null, processName: 'node.exe', timestamp: '2026-01-01T00:00:00.000Z' });
  const recentFsEvents = [
    { project_id: 'p1', occurred_at: '2026-01-01T00:00:01.000Z' },
    { project_id: 'p1', occurred_at: '2026-01-01T00:00:02.000Z' },
    { project_id: 'p1', occurred_at: '2026-01-01T00:00:03.000Z' },
  ];
  const result = correlateProject({
    record: { runtimeId, timestamp: '2026-01-01T00:00:00.000Z', executablePath: 'C:\\Program Files\\nodejs\\node.exe' },
    commandMetadata: { pathLikeArgs: [] },
    tree,
    projects: PROJECTS,
    recentFsEvents,
    correlationWindowMs: 4000,
  });
  assert.equal(result.projectId, 'p1');
  assert.equal(result.confidence, CONFIDENCE.LOW); // several temporal hits, still only one evidence KIND
});

test('project-correlator: inherited + temporal for the same project combine to MEDIUM', () => {
  const tree = new ProcessTree();
  const parentId = tree.addStart({ pid: 40, parentPid: null, processName: 'claude.exe', timestamp: '2026-01-01T00:00:00.000Z' });
  const childId = tree.addStart({ pid: 41, parentPid: 40, processName: 'node.exe', timestamp: '2026-01-01T00:00:01.000Z' });
  const correlations = new Map([[parentId, { projectId: 'p1', confidence: CONFIDENCE.MEDIUM, evidence: [] }]]);
  const recentFsEvents = [{ project_id: 'p1', occurred_at: '2026-01-01T00:00:01.500Z' }];

  const result = correlateProject({
    record: { runtimeId: childId, timestamp: '2026-01-01T00:00:01.000Z', executablePath: 'C:\\Program Files\\nodejs\\node.exe' },
    commandMetadata: { pathLikeArgs: [] },
    tree,
    projects: PROJECTS,
    correlations,
    recentFsEvents,
    correlationWindowMs: 4000,
  });
  assert.equal(result.projectId, 'p1');
  assert.equal(result.confidence, CONFIDENCE.MEDIUM);
  assert.equal(result.evidence.length, 2);
});

test('project-correlator: no evidence at all stays UNKNOWN, never defaults to a guess', () => {
  const tree = new ProcessTree();
  const runtimeId = tree.addStart({ pid: 50, parentPid: null, processName: 'notepad.exe', timestamp: 't0' });
  const result = correlateProject({
    record: { runtimeId, timestamp: 't0', executablePath: 'C:\\Windows\\notepad.exe' },
    commandMetadata: { pathLikeArgs: [] },
    tree,
    projects: PROJECTS,
  });
  assert.equal(result.projectId, null);
  assert.equal(result.confidence, CONFIDENCE.UNKNOWN);
  assert.deepEqual(result.evidence, []);
});
