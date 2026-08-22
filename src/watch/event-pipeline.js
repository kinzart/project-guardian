// Wires raw adapter events through filtering, protection, project resolution, significance
// classification, and coalescing, down to a targeted refresh — see SPEC_V0.3.md's pipeline
// diagram. Everything before the coalescer flush is synchronous and cheap; the flush handler is
// the only part that touches the store/inspectors.

import path from 'node:path';
import { isIgnoredChange, isProtectedChange, classifySignificance } from './filters.js';
import { normalizeRawEvent } from './normalizer.js';
import { resolveProject } from './project-resolver.js';
import { Coalescer } from './debounce.js';
import { refreshProject, getFamilyMembers } from '../discovery/refresh.js';
import { renderInventory } from '../report/inventory.js';
import { renderProjectStatus } from '../report/status.js';

function newEventId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isUnderAny(absPath, roots) {
  const normalized = absPath.replace(/\\/g, '/').toLowerCase();
  return roots.some((r) => {
    const root = r.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

export function createEventPipeline({ store, config, projects, reportsDir, guardianSelfPaths, stats, onRefresh, onIgnored, onProtected, onError }) {
  async function persistEvent(fields) {
    try {
      await store.addWatchEvent({ event_id: newEventId(), ...fields });
    } catch (err) {
      onError?.(err);
    }
  }

  async function refreshReports() {
    const lastScan = await store.getLastScan();
    await renderInventory({ store, reportsDir, lastScan });
    await renderProjectStatus({ store, reportsDir, lastScan });
  }

  async function handleFlush(projectId, batch) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;

    const reason = batch.pathClasses.includes('INTELLIGENCE_RELEVANT')
      ? 'INTELLIGENCE_RELEVANT'
      : batch.pathClasses.includes('DISCOVERY_RELEVANT')
        ? 'DISCOVERY_RELEVANT'
        : 'ACTIVITY_ONLY';

    let familyMembers = [];
    if (project.project_family) familyMembers = await getFamilyMembers(store, project.project_family);

    let result;
    try {
      result = await refreshProject({ store, project, config, reason, familyMembers });
    } catch (err) {
      onError?.(err);
      return;
    }

    const idx = projects.findIndex((p) => p.id === projectId);
    if (idx !== -1) projects[idx] = result.project;

    stats.refreshes += 1;
    if (result.intelligenceRecomputed) stats.intelligenceRecomputed += 1;
    else stats.intelligenceReused += 1;

    await persistEvent({
      occurred_at: batch.settledAt,
      project_id: projectId,
      project_root: project.root_path,
      event_type: 'PROJECT_SOURCE_CHANGED',
      paths: batch.paths.map((p) => path.relative(project.root_path, p).replace(/\\/g, '/')),
      path_classes: batch.pathClasses,
      raw_event_count: batch.rawEventCount,
      first_seen_at: batch.firstSeenAt,
      settled_at: batch.settledAt,
      triggered_refresh: true,
      intelligence_recomputed: result.intelligenceRecomputed,
    });

    try {
      await refreshReports();
    } catch (err) {
      onError?.(err);
    }

    onRefresh?.({ project: result.project, batch, intelligenceRecomputed: result.intelligenceRecomputed, reason });
  }

  const coalescer = new Coalescer({
    debounceMs: config.watch.debounceMs,
    settleMs: config.watch.settleMs,
    onFlush: (projectId, batch) => {
      handleFlush(projectId, batch).catch((err) => onError?.(err));
    },
  });

  function ingest(root, eventType, filename) {
    const raw = normalizeRawEvent({ root, eventType, filename });
    if (!raw) return;

    stats.eventsReceived += 1;

    if (isUnderAny(raw.absPath, guardianSelfPaths)) {
      // Never re-observe Guardian's own writes to its own data/reports/logs — the exact
      // self-loop the spec calls out. Not counted as "ignored" (it isn't project noise, it's
      // Guardian's own bookkeeping) and never persisted.
      return;
    }

    if (isProtectedChange(raw.absPath)) {
      stats.protectedEvents += 1;
      onProtected?.(raw);
      const project = resolveProject(raw.absPath, projects);
      persistEvent({
        occurred_at: raw.occurredAt,
        project_id: project?.id || null,
        project_root: project?.root_path || root,
        event_type: 'PROTECTED_SOURCE_CHANGED',
        paths: [],
        path_classes: [],
        raw_event_count: 1,
        first_seen_at: raw.occurredAt,
        settled_at: raw.occurredAt,
        triggered_refresh: false,
        intelligence_recomputed: false,
      }).catch((err) => onError?.(err));
      return;
    }

    if (isIgnoredChange(raw.absPath, { projectRoot: root, excludeNames: config.exclude, excludePaths: config.excludePaths })) {
      stats.eventsIgnored += 1;
      onIgnored?.(raw);
      return;
    }

    const project = resolveProject(raw.absPath, projects);
    if (!project) return;

    const significance = classifySignificance(raw.absPath, project.root_path);
    stats.eventsCoalesced += 1;
    coalescer.push(project.id, { ...raw, significance });
  }

  return { ingest, coalescer, refreshReports };
}
