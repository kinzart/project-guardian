import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { renderObsidianDashboard } from '../src/obsidian/renderer.js';

const project = { id: 'pg', name: 'PROJECT-GUARDIAN', status: { activity_state: 'ACTIVE', completion_state: 'IN_PROGRESS' } };
const runtime = { project_id: 'pg', operational_status: 'ACTIVE_NOW', active_agents: ['CODEX'], current_focus: { value: 'V0.7' }, last_meaningful_activity: '2026-08-21T00:00:00Z', next_actions: [{ text: 'render' }], open_blockers: [], confidence: 'HIGH' };

test('obsidian renderer: dashboard and project pages use real runtime data', () => {
  const vault = mkdtempSync(path.join(os.tmpdir(), 'guardian-vault-')); mkdirSync(path.join(vault, '.obsidian'));
  try { const result = renderObsidianDashboard({ vaultPath: vault, projects: [project], runtimeStates: [runtime], intelligence: [] }); assert.equal(result.projectsRendered, 1); assert.match(readFileSync(path.join(result.root, 'Dashboard.md'), 'utf8'), /ACTIVE NOW/); assert.match(readFileSync(path.join(result.root, 'Projects', 'PROJECT-GUARDIAN.md'), 'utf8'), /CODEX/); } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('obsidian renderer: preserves manual content and skips unchanged render', () => {
  const vault = mkdtempSync(path.join(os.tmpdir(), 'guardian-vault-')); mkdirSync(path.join(vault, '.obsidian'));
  try { const first = renderObsidianDashboard({ vaultPath: vault, projects: [project], runtimeStates: [runtime], intelligence: [] }); const file = path.join(first.root, 'Dashboard.md'); writeFileSync(file, `${readFileSync(file, 'utf8')}\nMy manual notes\n`); const second = renderObsidianDashboard({ vaultPath: vault, projects: [project], runtimeStates: [runtime], intelligence: [] }); assert.equal(second.changed, false); assert.match(readFileSync(file, 'utf8'), /My manual notes/); } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('obsidian renderer: duplicate project names get stable distinct pages', () => {
  const vault = mkdtempSync(path.join(os.tmpdir(), 'guardian-vault-')); mkdirSync(path.join(vault, '.obsidian'));
  try {
    const projects = [{ ...project, id: 'abcdefgh-one', name: 'same' }, { ...project, id: 'ijklmnop-two', name: 'same' }];
    const states = projects.map((p) => ({ ...runtime, project_id: p.id }));
    const result = renderObsidianDashboard({ vaultPath: vault, projects, runtimeStates: states, intelligence: [] });
    const dashboard = readFileSync(path.join(result.root, 'Dashboard.md'), 'utf8');
    assert.match(dashboard, /same--abcdefgh/); assert.match(dashboard, /same--ijklmnop/);
    assert.match(readFileSync(path.join(result.root, 'Projects', 'same--abcdefgh.md'), 'utf8'), /# same/);
    assert.match(readFileSync(path.join(result.root, 'Projects', 'same--ijklmnop.md'), 'utf8'), /# same/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
