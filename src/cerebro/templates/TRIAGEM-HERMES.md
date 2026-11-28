# Tarefa longa: triagem do Cérebro

Você é o Hermes fazendo a triagem de tudo que o Paixão tem no computador e no Drive. Pode demorar o quanto precisar e usar todos os modelos gratuitos disponíveis. Se os tokens acabarem, pare. Na próxima vez, continue de onde parou.

## Regras que nunca mudam

1. **Só leitura nas pastas dos projetos.** Não apague, mova, renomeie nem edite nada fora de `{{VAULT}}\Triagem\`.
2. Você **só escreve** em `{{VAULT}}\Triagem\`. Quem apaga é o Paixão: ele marca as caixinhas e roda `guardian cerebro limpar`.
3. No Google Drive (`G:\`), olhe só nomes, tamanhos e datas. **Não abra arquivos lá**, senão eles são baixados.
4. Projetos com `arquivo: true` (sem mudança há mais de 1 ano) só ganham uma linha de resumo. Não sugira apagar nada neles.
5. Na dúvida, não marque. É melhor deixar lixo do que sugerir apagar algo útil.

## Como trabalhar

1. Leia `{{VAULT}}\Triagem\_progresso.md`. Se não existir, crie com a lista de todas as notas de `{{VAULT}}\Project Guardian\Projetos\`, uma por linha, como `- [ ] Nome`.
2. Pegue o próximo `- [ ]`. Leia a nota do projeto (caminho, tipo, última mudança, última IA, conteúdo).
3. Liste a pasta do projeto, até 3 níveis e no máximo 400 entradas. Abra arquivos de texto pequenos só quando precisar entender o projeto (README, AGENTS.md, package.json).
4. Escreva `{{VAULT}}\Triagem\<Nome>.md` no formato abaixo.
5. Marque `- [x] Nome` no `_progresso.md` e siga para o próximo.

## O que procurar

- **Rastros de IA:** backups e fallbacks deixados para trás (`*.bak`, `*.orig`, `*.old`, `*-backup-*`, `*.probe-backup*`, `copy of`, `- cópia`, `_old`, `v1`/`v2` duplicados), pastas `tmp`, `temp`, `scratch`, `.tmp`, worktrees esquecidos, logs grandes.
- **Pesos mortos:** `node_modules`, `.venv`, `venv`, `dist`, `build` e caches em projetos parados há mais de 90 dias. Dá para recriar.
- **Duplicados:** arquivos com mesmo nome e tamanho em pastas diferentes do mesmo projeto.
- **O que o projeto é**, em 2 linhas, e se parece terminado, abandonado ou em andamento.

## Formato de cada arquivo de triagem

```
# <Nome do projeto>
Caminho: <caminho>
O que é: <2 linhas>
Situação: em andamento | parado | terminado | abandonado
Recomendação: manter | limpar | arquivar | apagar o projeto inteiro (explique)

## Sugestões de limpeza
- [ ] apagar: `<caminho completo>` — <motivo curto> (<tamanho>)
- [ ] apagar: `<caminho completo>` — <motivo curto> (<tamanho>)
```

Use sempre o caminho completo entre crases, um item por linha, com `- [ ] apagar:` exatamente assim. O Paixão vai trocar `[ ]` por `[x]` no que concordar.
