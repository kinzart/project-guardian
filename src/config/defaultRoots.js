import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listWindowsDriveRoots, systemDriveRoot } from '../util/paths.js';

const USERPROFILE_SUBFOLDERS = [
  'Documents',
  'Desktop',
  'source',
  path.join('source', 'repos'),
  'projects',
  'Projects',
  'dev',
  'workspace',
  'code',
];

// Telltale marker entries left at the root of a cloud-sync virtual drive (Google Drive File
// Stream, OneDrive, Dropbox mapped drives, ...). These are excluded from auto-detected roots:
// they're frequently network-backed, can be very large, and are not local dev project storage.
// A user who genuinely wants one scanned can still add it to scanRoots by hand.
const CLOUD_SYNC_MARKERS = ['.shortcut-targets-by-id', 'Meu Drive', 'My Drive', '.Encrypted'];

function looksLikeCloudSyncDrive(driveRoot) {
  return CLOUD_SYNC_MARKERS.some((marker) => existsSync(path.join(driveRoot, marker)));
}

// Auto-detect plausible development roots without ever scanning the whole system drive.
// - Known dev-shaped subfolders under %USERPROFILE% that actually exist.
// - The root of every fixed, non-cloud-sync drive other than the system drive (bounded later
//   by the walker's exclude list + maxDepth, so this is not a naive full-drive scan).
export function detectDefaultRoots() {
  const roots = [];
  const home = os.homedir();
  for (const sub of USERPROFILE_SUBFOLDERS) {
    const candidate = path.join(home, sub);
    if (existsSync(candidate)) roots.push(candidate);
  }

  if (os.platform() === 'win32') {
    const sysRoot = systemDriveRoot();
    for (const drive of listWindowsDriveRoots()) {
      if (drive.toLowerCase() === sysRoot.toLowerCase()) continue;
      if (looksLikeCloudSyncDrive(drive)) continue;
      roots.push(drive);
    }
  }

  return Array.from(new Set(roots));
}
