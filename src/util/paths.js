import { existsSync } from 'node:fs';
import os from 'node:os';

export function toDisplayPath(p) {
  return p.split('\\').join('/');
}

// Enumerate fixed drive letters that exist on this Windows machine by probing A..Z.
// Cheap: existsSync on a drive root is a single stat-like call, not a scan.
export function listWindowsDriveRoots() {
  if (os.platform() !== 'win32') return [];
  const roots = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

export function systemDriveRoot() {
  const sysRoot = process.env.SystemDrive || 'C:';
  return `${sysRoot.replace(/:$/, '')}:\\`;
}

export function stableProjectId(rootPath) {
  // Small, dependency-free stable hash (FNV-1a) of the normalized path.
  const normalized = rootPath.toLowerCase().split('\\').join('/');
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
