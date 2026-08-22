// Command-line sanitization — see SPEC_V0.4.md "Sanitization". The raw command line string is
// NEVER returned or stored by this module; callers only ever get a small structured summary.

import { isSecretPath } from '../util/secrets.js';

// Executable paths are ordinary process metadata (already surfaced throughout Guardian's
// reports as root_path), not user content — but if a segment happens to look secret-shaped
// (e.g. an exe living under a credentials-named folder), redact that segment rather than the
// whole path, so the rest of the location is still useful for project correlation.
export function sanitizeExecutablePath(execPath) {
  if (!execPath) return null;
  const segments = execPath.split(/[\\/]+/);
  return segments.map((seg) => (isSecretPath(seg) ? '[REDACTED]' : seg)).join('\\');
}

const SENSITIVE_FLAGS = /^--?(api-key|token|password|secret|auth|authorization)$/i;

const SECRET_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9-]/, // OpenAI/Anthropic-style API key prefix
  /^ghp_[a-zA-Z0-9]/, // GitHub personal access token
  /^bearer$/i,
  /^authorization:/i,
];

const SECRET_ENV_NAME = /(API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD)$/i;

function looksLikeSecretToken(token) {
  if (SECRET_VALUE_PATTERNS.some((re) => re.test(token))) return true;
  const eq = token.indexOf('=');
  if (eq > 0) {
    const name = token.slice(0, eq);
    if (SECRET_ENV_NAME.test(name)) return true;
  }
  return false;
}

function looksLikePath(token) {
  return /^[a-zA-Z]:[\\/]/.test(token) || token.includes('/') || token.includes('\\');
}

// Returns { argCount, pathLikeArgs, redactedCount } — never the raw command line. mode "none"
// extracts nothing at all (used only if a future config explicitly opts out).
export function sanitizeCommandMetadata(commandLine, mode = 'sanitized-minimal') {
  if (!commandLine || mode === 'none') return { argCount: 0, pathLikeArgs: [], redactedCount: 0 };

  const tokens = commandLine.trim().split(/\s+/).filter(Boolean);
  const pathLikeArgs = [];
  let redactedCount = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const prev = tokens[i - 1];

    if (prev && SENSITIVE_FLAGS.test(prev)) {
      redactedCount += 1; // this token is the value of a sensitive flag
      continue;
    }
    if (SENSITIVE_FLAGS.test(token)) continue; // the flag itself carries no path information

    if (looksLikeSecretToken(token)) {
      redactedCount += 1;
      continue;
    }

    if (looksLikePath(token)) pathLikeArgs.push(token);
  }

  return { argCount: tokens.length, pathLikeArgs, redactedCount };
}
