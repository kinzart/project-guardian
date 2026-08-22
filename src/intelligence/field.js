// Evidence-backed field helper shared by the whole intelligence layer. Every semantic
// conclusion in V0.2 is a { value, confidence, evidence[] } triple — never a bare value — so a
// consumer can always ask "why does Guardian think this?" (see `guardian explain`).

// AUTHORITATIVE sits above HIGH — reserved for evidence a source states about itself directly
// (e.g. Claude Code's own native SessionStart cwd), never inferred/correlated the way process or
// shell evidence is. See SPEC_V0.6A.md "Authoritative evidence".
export const CONFIDENCE = { AUTHORITATIVE: 'AUTHORITATIVE', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', UNKNOWN: 'UNKNOWN' };

export function field(value, confidence, evidence = []) {
  return { value, confidence, evidence };
}

export const UNKNOWN_FIELD = Object.freeze({ value: null, confidence: CONFIDENCE.UNKNOWN, evidence: [] });

export function evidence(source, snippet, timestamp = null) {
  return { source, snippet: snippet ?? null, timestamp: timestamp ?? null };
}
