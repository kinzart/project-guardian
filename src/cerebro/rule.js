import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const RULE_START = '<!-- >>> CEREBRO >>> -->';
export const RULE_END = '<!-- <<< CEREBRO <<< -->';

export function ruleText(vaultPath) {
  const sep = vaultPath.includes('\\') ? '\\' : '/';
  const inbox = `${vaultPath.replace(/[\\/]+$/, '')}${sep}Caixa de entrada`;
  return `${RULE_START}
## Cérebro (resumo universal)
Ao terminar uma tarefa num projeto, acrescente no fim de \`${inbox}${sep}<nome da pasta do projeto>.md\` um parágrafo com a data de hoje e 3 a 5 linhas: o que foi feito, onde parou e o próximo passo. Crie o arquivo se não existir. Não escreva nada dentro da pasta do projeto por causa disso.
${RULE_END}`;
}

const strip = (text) => {
  const s = text.indexOf(RULE_START); const e = text.indexOf(RULE_END);
  if (s < 0 || e < s) return text;
  return `${text.slice(0, s).replace(/\n+$/, '')}${text.slice(e + RULE_END.length).replace(/^\n+/, s > 0 ? '\n' : '')}`;
};

export function installRule(file, vaultPath) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const base = strip(existing).replace(/\s+$/, '');
  const next = `${base ? `${base}\n\n` : ''}${ruleText(vaultPath)}\n`;
  if (next === existing) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, next);
  return true;
}

export function removeRule(file) {
  if (!existsSync(file)) return false;
  const existing = readFileSync(file, 'utf8');
  const next = strip(existing);
  if (next === existing) return false;
  writeFileSync(file, next.replace(/\s+$/, '') ? `${next.replace(/\s+$/, '')}\n` : '');
  return true;
}
