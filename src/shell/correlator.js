// Thin, shell-domain-named wrapper over the shared path->project resolver — see
// SPEC_V0.5A.md section 8. The actual HIGH-confidence evidence branch lives in
// src/process/project-correlator.js (correlateProject's shellCwd input), which is where
// observer.js calls in. This module exists for CLI/report code that just needs "what project is
// this CWD in" without pulling in the whole process-correlation pipeline.

import { resolveProjectForPath } from '../process/project-correlator.js';

export function resolveProjectForCwd(cwd, projects) {
  return resolveProjectForPath(cwd, projects);
}
