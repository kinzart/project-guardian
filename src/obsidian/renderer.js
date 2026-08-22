import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const START = '<!-- >>> PROJECT GUARDIAN GENERATED >>> -->';
export const END = '<!-- <<< PROJECT GUARDIAN GENERATED <<< -->';

function replaceGenerated(existing, generated) {
  const block = `${START}\n${generated.trim()}\n${END}`;
  const start = existing.indexOf(START); const end = existing.indexOf(END);
  if (start >= 0 && end > start) return `${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`;
  return existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

function writePreserving(file, generated) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const next = replaceGenerated(existing, generated);
  if (next === existing) return false;
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, next); return true;
}

function value(field) { return field?.value || 'UNKNOWN'; }
function list(items, pick = (x) => x.text) { return items?.length ? items.map((x) => `- ${pick(x)}`).join('\n') : '- none detected'; }

export function renderObsidianDashboard({ vaultPath, projects, runtimeStates, intelligence }) {
  const root = path.join(vaultPath, 'Project Guardian'); const projectDir = path.join(root, 'Projects');
  const runtime = new Map(runtimeStates.map((s) => [s.project_id, s])); const intel = new Map(intelligence.map((s) => [s.project_id, s]));
  const nameCounts = new Map(); for (const p of projects) nameCounts.set(p.name, (nameCounts.get(p.name) || 0) + 1);
  const stem = (p) => safe(nameCounts.get(p.name) > 1 ? `${p.name}--${String(p.id).slice(0, 8)}` : p.name);
  const groups = new Map();
  for (const p of projects) { const status = runtime.get(p.id)?.operational_status || p.status?.activity_state || 'UNKNOWN'; if (!groups.has(status)) groups.set(status, []); groups.get(status).push(p); }
  const order = ['ACTIVE_NOW', 'BLOCKED', 'RECENTLY_ACTIVE', 'ACTIVE', 'WARM', 'STALE', 'DORMANT', 'DONE', 'IDLE', 'UNKNOWN'];
  const dashboard = ['# Project Guardian Dashboard', '', ...order.flatMap((status) => {
    const items = groups.get(status) || []; if (!items.length) return [];
    return [`## ${status.replaceAll('_', ' ')}`, ...items.map((p) => { const r = runtime.get(p.id); const i = intel.get(p.id); return `- [[Projects/${stem(p)}|${p.name}]] — focus: ${value(r?.current_focus || i?.current_focus)}; agents: ${r?.active_agents?.join(', ') || 'none'}; confidence: ${r?.confidence || 'UNKNOWN'}`; }), ''];
  })].join('\n');
  let changed = writePreserving(path.join(root, 'Dashboard.md'), dashboard);
  for (const p of projects) {
    const r = runtime.get(p.id); const i = intel.get(p.id);
    const page = `# ${p.name}\n\n## Operational\n${r?.operational_status || 'UNKNOWN'}\n\n## Completion\n${p.status?.completion_state || 'UNKNOWN'}\n\n## Active agents\n${r?.active_agents?.join(', ') || 'none'}\n\n## Current focus\n${value(r?.current_focus || i?.current_focus)}\n\n## Last meaningful activity\n${r?.last_meaningful_activity || 'UNKNOWN'}\n\n## Next\n${list(r?.next_actions || i?.next_steps)}\n\n## Blockers\n${list(r?.open_blockers || i?.blockers)}\n\n## Evidence confidence\n${r?.confidence || 'UNKNOWN'}`;
    changed = writePreserving(path.join(projectDir, `${stem(p)}.md`), page) || changed;
  }
  return { root, changed, projectsRendered: projects.length };
}

function safe(name) { return String(name).replace(/[<>:"/\\|?*]/g, '-'); }
