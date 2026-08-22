import { execFile } from 'node:child_process';

// Read-only git metadata. Every call is a fixed argument array via execFile (never a shell
// string), and only these four subcommands are ever invoked: rev-parse, log, status, remote.
// Never commit/push/pull/merge/checkout/reset/rebase.

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function stripCredentials(remoteUrl) {
  // Strip any userinfo@ component (https://user:pass@host/... or ssh equivalents).
  return remoteUrl.replace(/^(\w+:\/\/)[^/@]+@/, '$1').replace(/^([\w.-]+@)/, (m) => (m.includes('://') ? m : m));
}

export async function inspectGit(projectRoot) {
  const result = { present: true, errors: [] };

  try {
    result.branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot);
  } catch (err) {
    result.branch = null;
    result.errors.push(`branch lookup failed: ${err.message}`);
  }

  try {
    const log = await run(['log', '-1', '--format=%H%x1f%cI%x1f%s'], projectRoot);
    const [hash, date, subject] = log.split('\x1f');
    result.lastCommitHash = hash || null;
    result.lastCommitDate = date || null;
    // Evidence only, never authoritative on its own — a commit message like "finish project"
    // must never by itself flip completion_state to DONE (see src/intelligence/snapshot.js).
    result.lastCommitMessage = subject || null;
  } catch (err) {
    result.lastCommitHash = null;
    result.lastCommitDate = null;
    result.lastCommitMessage = null;
    result.errors.push(`log lookup failed: ${err.message}`);
  }

  try {
    const since = await run(['log', '--since=30.days', '--format=%H'], projectRoot);
    result.recentCommitCount = since ? since.split('\n').filter(Boolean).length : 0;
  } catch (err) {
    result.recentCommitCount = null;
    result.errors.push(`recent commit count failed: ${err.message}`);
  }

  try {
    const status = await run(['status', '--porcelain'], projectRoot);
    const lines = status ? status.split('\n').filter(Boolean) : [];
    result.dirty = lines.length > 0;
    result.modifiedFiles = lines.slice(0, 50).map((l) => l.slice(3));
  } catch (err) {
    result.dirty = null;
    result.modifiedFiles = [];
    result.errors.push(`status lookup failed: ${err.message}`);
  }

  try {
    const remotes = await run(['remote', '-v'], projectRoot);
    const seen = new Set();
    result.remotes = (remotes ? remotes.split('\n').filter(Boolean) : [])
      .map((line) => {
        const [name, urlAndType] = line.split('\t');
        const url = (urlAndType || '').split(' ')[0];
        return { name, url: stripCredentials(url) };
      })
      .filter((r) => {
        const key = `${r.name}:${r.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  } catch (err) {
    result.remotes = [];
    result.errors.push(`remote lookup failed: ${err.message}`);
  }

  return result;
}
