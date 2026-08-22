function fact(state, project) {
  return {
    project_id: project.id,
    project: project.name,
    operational_status: state?.operational_status || 'UNKNOWN',
    completion: project.status?.completion_state || 'UNKNOWN',
    current_focus: state?.current_focus?.value || 'UNKNOWN',
    active_agents: state?.active_agents || [],
    last_activity: state?.last_meaningful_activity || null,
    blockers: (state?.open_blockers || []).map((b) => b.text),
    next_actions: (state?.next_actions || []).map((a) => a.text),
    confidence: state?.confidence || 'UNKNOWN',
    evidence: [...(state?.evidence || []), ...(state?.current_focus?.evidence || [])].slice(0, 10),
  };
}

export function runStructuredQuery({ type, projects, runtimeStates, projectQuery }) {
  const states = new Map(runtimeStates.map((s) => [s.project_id, s]));
  let facts = projects.map((p) => fact(states.get(p.id), p));
  if (type === 'active') facts = facts.filter((f) => f.operational_status === 'ACTIVE_NOW');
  else if (type === 'blocked') facts = facts.filter((f) => f.operational_status === 'BLOCKED' || f.blockers.length);
  else if (type === 'recent') facts = facts.filter((f) => ['ACTIVE_NOW', 'RECENTLY_ACTIVE'].includes(f.operational_status));
  else if (type === 'project') {
    const q = String(projectQuery || '').toLowerCase(); facts = facts.filter((f) => f.project.toLowerCase().includes(q) || f.project_id === projectQuery);
  } else if (type !== 'all') throw new Error(`unknown query type: ${type}`);
  return facts.sort((a, b) => String(b.last_activity || '').localeCompare(String(a.last_activity || '')));
}

export function interpretQuestion(question) {
  const q = String(question || '').toLowerCase();
  if (/bloquead|blocked/.test(q)) return { type: 'blocked' };
  if (/semanas|weeks|não mexo|nao mexo/.test(q)) return { type: 'all', intent: 'stale' };
  if (/aconteceu hoje|today/.test(q)) return { type: 'recent', intent: 'today' };
  if (/priori|retomar|should/.test(q)) return { type: 'all', intent: 'recommend' };
  if (/trabalhando|working|active/.test(q)) return { type: 'active' };
  const quoted = q.match(/["']([^"']+)["']/)?.[1];
  if (/onde parei|where.*left/.test(q)) return { type: 'project', projectQuery: quoted || q.replace(/^.*(?:onde parei no|where.*left off.*)\s*/i, '').trim() };
  return { type: 'recent' };
}

export function synthesizeDeterministically({ question, facts, intent }) {
  if (!facts.length) return { facts: [], answer: 'Nenhum fato correspondente foi encontrado. Estado: UNKNOWN.', recommendation: null };
  const lines = facts.slice(0, 10).map((f) => `${f.project}: ${f.operational_status}; foco: ${f.current_focus}; confidence: ${f.confidence}.`);
  let recommendation = null;
  if (intent === 'recommend') {
    const candidate = facts.find((f) => f.blockers.length === 0 && f.completion !== 'DONE') || facts[0];
    recommendation = `Recomendação: considerar ${candidate.project}. Critério: trabalho não concluído, sem bloqueador detectado e atividade mais recente entre os candidatos.`;
  }
  return { facts, answer: lines.join('\n'), recommendation };
}
