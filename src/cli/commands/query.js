import path from 'node:path';
import { createStore } from '../../store/createStore.js';
import { refreshRuntimeStates } from '../../activity/runtime-rollup.js';
import { interpretQuestion, runStructuredQuery, synthesizeDeterministically } from '../../query/engine.js';

async function facts(projectRoot, type, projectQuery) {
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db')); const runtimeStates = await refreshRuntimeStates(store); const projects = await store.listProjects(); await store.close();
  return runStructuredQuery({ type, projectQuery, projects, runtimeStates });
}

export async function queryCommand({ projectRoot, args }) {
  const type = args[0] || 'all'; const projectQuery = type === 'project' ? args.slice(1).join(' ') : null;
  try { const result = await facts(projectRoot, type, projectQuery); console.log(JSON.stringify({ query: type, facts: result }, null, 2)); return result; }
  catch (err) { console.error(err.message); process.exitCode = 1; return null; }
}

export async function askCommand({ projectRoot, args }) {
  const question = args.join(' ').trim(); if (!question) { console.error('Usage: guardian ask "question"'); process.exitCode = 1; return null; }
  const parsed = interpretQuestion(question); const resolved = await facts(projectRoot, parsed.type, parsed.projectQuery); const result = synthesizeDeterministically({ question, facts: resolved, intent: parsed.intent });
  console.log('FACTS'); console.log(result.answer); if (result.recommendation) { console.log('\nRECOMMENDATION'); console.log(result.recommendation); }
  console.log('\nEVIDENCE'); for (const f of result.facts) console.log(`- ${f.project}: ${f.evidence.map((e) => e.source).filter(Boolean).join(', ') || 'none'}; confidence=${f.confidence}`);
  return result;
}
