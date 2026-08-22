// Process classification + agent identity — see SPEC_V0.4.md "Classification"/"Agent detection".
// Rules are data (overridable via config.process.classificationOverrides), never hardcoded
// branching per binary. Agent identity is only ever assigned from objective evidence (binary
// name and/or a known executable-path fragment) — never inferred from a generic runtime like
// node.exe running alone.

const AGENT_RULES = [
  { name: /^claude(\.exe)?$/i, pathHint: /[\\/]claude[\\/]/i, agentType: 'CLAUDE_CODE' },
  { name: /^codex(\.exe)?$/i, pathHint: /[\\/]codex[\\/]/i, agentType: 'CODEX' },
  { name: /^gptwork(\.exe)?$/i, pathHint: /[\\/]gptwork[\\/]/i, agentType: 'GPTWORK' },
  { name: /^hermes(\.exe)?$/i, pathHint: /[\\/]hermes[\\/]/i, agentType: 'HERMES' },
];

const DEFAULT_RULES = [
  { pattern: /^(powershell|pwsh|cmd|bash|zsh|sh|wsl)(\.exe)?$/i, classification: 'SHELL' },
  { pattern: /^(windowsterminal|conhost|explorer)(\.exe)?$/i, classification: 'TERMINAL_HOST' },
  { pattern: /^(node|python|python3|php|java|ruby|deno|bun)(\.exe)?$/i, classification: 'DEV_RUNTIME' },
  { pattern: /^git(\.exe)?$/i, classification: 'VERSION_CONTROL' },
  { pattern: /^(code|code-insiders|devenv|idea64|pycharm64|subl)(\.exe)?$/i, classification: 'EDITOR' },
  { pattern: /^(npm|npx|yarn|pnpm|pip|pip3|cargo|go|dotnet)(\.exe)?$/i, classification: 'TOOLING' },
];

function compileOverrides(overrides = []) {
  return overrides.map((o) => ({ ...o, pattern: new RegExp(o.pattern, 'i') }));
}

// classifyProcess(processName, { executablePath }, config) -> { classification, agentType, evidence }
export function classifyProcess(processName, { executablePath } = {}, config = {}) {
  const evidence = [];
  const name = (processName || '').trim();
  const overrides = compileOverrides(config?.process?.classificationOverrides);

  const override = overrides.find((o) => o.pattern.test(name));
  if (override) {
    evidence.push(`config override matched binary name: ${name}`);
    return { classification: override.classification, agentType: override.agentType || null, evidence };
  }

  const agentRule = AGENT_RULES.find((r) => r.name.test(name));
  if (agentRule) {
    evidence.push(`binary name matches known agent: ${name}`);
    if (executablePath && agentRule.pathHint.test(executablePath)) {
      evidence.push(`executable path matches known agent install pattern: ${executablePath}`);
    }
    return { classification: 'AI_AGENT', agentType: agentRule.agentType, evidence };
  }

  const rule = DEFAULT_RULES.find((r) => r.pattern.test(name));
  if (rule) {
    evidence.push(`binary name matches ${rule.classification}: ${name}`);
    return { classification: rule.classification, agentType: null, evidence };
  }

  return { classification: 'OTHER', agentType: null, evidence: [] };
}
