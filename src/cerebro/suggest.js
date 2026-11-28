import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { START, END } from '../obsidian/renderer.js';
import { kindLabel, lastActivityIso } from './summary.js';

export const DIGEST_MAX = 60 * 1024;

export const PROMPT = `Você é o analista do "Cérebro", o inventário de projetos do Paixão (código, IA, música, vídeo, design, documentos).
Abaixo está uma linha por projeto: nome | tipo | última mudança | última IA | caminho. Depois, grupos de possíveis duplicados.
Escreva em português, em Markdown, com estas seções curtas:
## Retomar primeiro (até 5, com o motivo)
## Unir (projetos que parecem a mesma coisa, com caminhos)
## Pode descartar (só sugestão, com o motivo)
## Problemas potenciais
Regras: apenas sugira. Não execute comandos, não abra, mova, edite nem apague arquivos. Projetos sem mudança há mais de 1 ano ficam como estão: não sugira mexer neles.`;

export function buildInventoryDigest(projects, sessionsByProject = new Map(), duplicates = []) {
  const rows = projects.map((p) => {
    const s = sessionsByProject.get(p.id) || [];
    const last = lastActivityIso(p, s);
    return { last, line: `${p.name} | ${kindLabel(p.kind)} | ${last ? last.slice(0, 10) : '—'} | ${s[0] ? `${s[0].agent} ${String(s[0].updated_at).slice(0, 10)}` : '—'} | ${p.root_path}` };
  }).sort((a, b) => String(b.last).localeCompare(String(a.last)));
  const dup = duplicates.map((g) => `- ${g.projects.map((p) => p.root_path).join('  ==  ')}`);
  let text = `# Projetos (${projects.length})\n${rows.map((r) => r.line).join('\n')}\n\n# Possíveis duplicados\n${dup.join('\n') || '- nenhum'}\n`;
  if (Buffer.byteLength(text) > DIGEST_MAX) text = `${Buffer.from(text).subarray(0, DIGEST_MAX).toString('utf8')}\n(… lista cortada)\n`;
  return text;
}

function writeGenerated(file, content) {
  const block = `${START}\n${content.trim()}\n${END}`;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const s = existing.indexOf(START); const e = existing.indexOf(END);
  const next = s >= 0 && e > s ? `${existing.slice(0, s)}${block}${existing.slice(e + END.length)}` : `${block}\n${existing ? `\n${existing}` : ''}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, next);
}

// Runs the configured AI CLI with PROMPT + digest on stdin and writes its answer to outPath.
export function runSuggestions({ command, digest, outPath, now = new Date(), timeoutMs = 15 * 60 * 1000, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let done = false;
    const child = spawnImpl(command, { shell: true, windowsHide: true });
    const finish = (ok, reason) => {
      if (done) return; done = true; clearTimeout(timer);
      const stamp = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const body = ok && out.trim()
        ? `# Sugestões\n\n_Gerado em ${stamp} por \`${command}\`. Só sugestões: nada foi alterado._\n\n${out.trim()}`
        : `# Sugestões\n\n_Falhou em ${stamp}: ${reason || err.trim().slice(0, 500) || 'sem resposta'}_`;
      writeGenerated(outPath, body);
      resolve({ ok: ok && Boolean(out.trim()), outPath });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false, 'tempo esgotado'); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(false, e.message));
    child.on('close', (code) => finish(code === 0, code === 0 ? null : `saída ${code}`));
    child.stdin?.end(`${PROMPT}\n\n${digest}`);
  });
}
