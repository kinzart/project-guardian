import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export function pruneLogs(logsDir, { retentionDays = 30, maxTotalBytes = 50 * 1024 * 1024, now = Date.now() } = {}) {
  let files;
  try { files = readdirSync(logsDir).map((name) => { const filePath = path.join(logsDir, name); const stat = statSync(filePath); return { filePath, size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() }; }).filter((f) => f.isFile).sort((a, b) => a.mtimeMs - b.mtimeMs); } catch (e) { if (e.code === 'ENOENT') return { removed: 0, bytesRemaining: 0 }; throw e; }
  const cutoff = now - retentionDays * 86400000;
  let removed = 0;
  for (const file of [...files]) if (file.mtimeMs < cutoff) { unlinkSync(file.filePath); files = files.filter((f) => f !== file); removed += 1; }
  let total = files.reduce((sum, f) => sum + f.size, 0);
  for (const file of files) { if (total <= maxTotalBytes) break; unlinkSync(file.filePath); total -= file.size; removed += 1; }
  return { removed, bytesRemaining: total };
}

export function msUntilNextSchedule(times, now = new Date()) {
  const candidates = times.map((value) => { const [hour, minute] = value.split(':').map(Number); const d = new Date(now); d.setHours(hour, minute, 0, 0); if (d <= now) d.setDate(d.getDate() + 1); return d; });
  return Math.min(...candidates.map((d) => d.getTime() - now.getTime()));
}

export function startMaintenanceScheduler({ times, run, onError = () => {}, setTimer = setTimeout }) {
  let stopped = false;
  let timer;
  const schedule = () => { if (stopped) return; timer = setTimer(async () => { try { await run(); } catch (e) { onError(e); } finally { schedule(); } }, msUntilNextSchedule(times)); timer.unref?.(); };
  schedule();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
