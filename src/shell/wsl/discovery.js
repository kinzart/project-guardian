// WSL detection + distro discovery — see SPEC_V0.5C.md section 1. Never assumes WSL is
// installed; every caller must handle `{ installed: false }`.

import { execFileSync } from 'node:child_process';

// wsl.exe writes UTF-16LE to stdout regardless of console codepage — confirmed on this machine
// by inspecting the raw bytes (each character followed by a 0x00 byte). Decoding as plain utf8
// would silently mangle every distro name.
function runWsl(args, { timeout = 8000 } = {}) {
  try {
    const buf = execFileSync('wsl.exe', args, { encoding: 'buffer', timeout, windowsHide: true });
    return { ok: true, text: buf.toString('utf16le') };
  } catch (err) {
    // A non-zero exit (confirmed: --status exits 50, --list falls through to help text, both
    // when WSL itself isn't installed) still carries useful stdout/stderr on some builds — pass
    // it through so parseWslListOutput can see it, but never throw upward.
    const stdout = err.stdout ? Buffer.from(err.stdout).toString('utf16le') : '';
    return { ok: false, text: stdout, error: err.message };
  }
}

const HEADER_PATTERN = /NAME/i;

// Pure parser — see test/wsl-units.test.js for fixtures covering absent/no-distro/WSL1/WSL2/
// multi-distro cases without needing a real WSL installation.
export function parseWslListOutput(text) {
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !HEADER_PATTERN.test(l));

  const distros = [];
  for (const rawLine of lines) {
    const isDefault = rawLine.startsWith('*');
    const line = (isDefault ? rawLine.slice(1) : rawLine).trim();
    const parts = line.split(/\s{2,}/).filter(Boolean);
    if (parts.length < 3) continue; // not a distro row (e.g. leftover help/usage text)
    const [name, state, version] = parts;
    if (!/^\d+$/.test(version)) continue; // version column must be numeric (1 or 2) — a real guard against parsing help text
    distros.push({ name, state, wslVersion: version, isDefault });
  }
  return distros;
}

// Real detection. Returns { installed: false } when wsl.exe can't produce a distro list at all
// (confirmed on this machine: that's exactly what "WSL not installed" looks like) — never
// throws, never assumes.
export function detectWsl() {
  const listResult = runWsl(['--list', '--verbose']);
  const distros = parseWslListOutput(listResult.text);
  if (distros.length === 0) {
    return { installed: false, distros: [] };
  }
  return { installed: true, distros };
}
