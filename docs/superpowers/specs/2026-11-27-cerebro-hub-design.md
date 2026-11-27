# Painel central de projetos ("Cérebro") — desenho

Data: 2026-11-27 · Pedido por Paixão · Status: aguardando aprovação

## Por quê

Paixão tem muitos projetos espalhados (código, IA, música, vídeo, design, documentos) em vários discos e no Google Drive, e trabalha com várias IAs (Codex, Claude, Hermes, ChatGPT). Hoje, para retomar algo, precisa lembrar onde está e caçar o resumo em cada IA. Quer **um lugar só** que mostre tudo que existe, o estado de cada coisa e como retomar com um clique.

## Objetivos

1. Inventário de tudo em `Documents`, `D:`, `E:`, `F:` e Google Drive (`G:\Meu Drive`), **ignorando Downloads**.
2. Por projeto: status (ativo, parado, dormindo, concluído), última modificação e qual arquivo mudou.
3. Por projeto: **última IA que mexeu** (Codex / Claude / Hermes), data, o resumo dela e **um clique que reabre aquela sessão** na pasta do projeto.
4. Um **resumo universal** por projeto, igual para qualquer IA ler.
5. Árvore/mapa: disco → área → projeto, com ligações entre projetos relacionados.
6. Coisas antigas (sem mudança há mais de 1 ano) marcadas **"Arquivo — não mexer"**.
7. Análise noturna por IA: possíveis duplicados, o que unir, o que descartar, problemas.
8. Daqui pra frente, tudo que for criado ou mexido entra sozinho.

## Fora do escopo (agora)

- Mover, apagar ou unificar qualquer coisa automaticamente. O painel **só sugere**; qualquer limpeza é feita depois, com aprovação explícita, item por item.
- Conversas do ChatGPT no site (não ficam no PC). Entram numa v2, via exportação do ChatGPT ou link manual.
- App novo com interface própria. A interface é o Obsidian.

## O que faria isso dar errado mesmo "funcionando"

- Baixar o Google Drive inteiro sem querer (ler conteúdo de arquivo que está só na nuvem força o download).
- Alterar arquivos dos projetos.
- Um painel tão poluído (milhares de pastas soltas) que ninguém abre.
- Deixar o PC lento durante o dia.

## Abordagens consideradas

- **A. Completar o Project Guardian** — escolhida pelo Paixão. Já tem varredura, status, ligação com Claude/Codex, serviço rodando no PC e gerador de painel no Obsidian.
- B. Script novo só gerando notas — descartado: refaz o que o Guardian já faz.
- C. Só Obsidian + regra para as IAs — descartado como solução principal (depende das IAs obedecerem e não cobre o passado), mas **usado como reforço** (item 5 abaixo).

## O que existe hoje no PC (verificado)

- Guardian 1.0.0 instalado e rodando como serviço; banco em `%LOCALAPPDATA%\Project Guardian\data\guardian.db` (~570 MB), varre `Documents`, `D:\`, `E:\` 3x por dia.
- `obsidian.vaultPath` está **vazio**: o painel nunca foi gerado.
- `F:\` (APLICATIVOS AUTORAIS, FBS, MIX MASTER AUTO, SUPERAGENT...) **não** está na varredura.
- Google Drive para desktop montado em `G:\Meu Drive`.
- Codex guarda sessões em `~\.codex\sessions\AAAA\MM\DD\*.jsonl` (576 hoje), cada uma com `cwd` = pasta do projeto e `id` da sessão.
- Hermes guarda sessões em `%LOCALAPPDATA%\hermes\sessions` (formato a conferir).
- Claude Code: sessões em `~\.claude\projects\...` (local a confirmar no PC).

## Desenho

### 1. Cofre do Obsidian
Um cofre novo, `D:\CEREBRO` (minha escolha; muda fácil). O Guardian escreve em `D:\CEREBRO\Project Guardian\` mantendo o que já faz: só substitui o bloco gerado e preserva o que você escrever à mão em cada nota. Plugin Dataview para as tabelas.

### 2. Varredura
- Raízes: `Documents`, `D:\`, `E:\`, `F:\`, `G:\Meu Drive`. Excluir `Downloads` (e as exclusões que já existem).
- **Drive = só metadados** (nome, tamanho, datas). Nunca lê conteúdo de arquivo que esteja só na nuvem.
- Além de projetos de código, reconhecer **projetos criativos** por marcadores: Studio One (`.song`), Ableton (`.als`), FL (`.flp`), Cubase (`.cpr`), Premiere (`.prproj`), rascunhos do CapCut, `.psd`/`.ai`/`.blend`, pastas com muitos áudios/vídeos/documentos.
- Pastas de 1º e 2º nível de cada raiz viram **áreas** (ex.: `F:\MIX MASTER AUTO`), para a árvore ficar navegável mesmo quando não há marcador.
- Roda de madrugada (03:00) a varredura completa, além do acompanhamento ao vivo que o Guardian já faz.

### 3. Nota de cada projeto
Uma nota com propriedades (para filtrar no Dataview) e seções:

```
status: parado · última mudança: 12/11/2026 (mix_v3.song)
última IA: Codex · 25/11/2026
área: F:\MIX MASTER AUTO · tipo: música · arquivo: não

## Resumo universal
(3–6 linhas: o que é, onde parou, próximo passo)

## Última IA
Codex, 25/11 23:10 — "Terminei o pipeline de mixagem; falta exportar stems."
[▶ Retomar esta sessão]   [histórico de sessões]

## Próximos passos / Bloqueios   (o Guardian já extrai)
## Relacionados   [[outro projeto]]
## Minhas notas   (manual, nunca sobrescrito)
```

### 4. Índice de sessões das IAs ("última IA + resumo + retomar")
- Lê os arquivos de sessão do **Codex, Claude Code e Hermes**, liga cada sessão ao projeto pela pasta de trabalho (`cwd`) e guarda: IA, data, id, e a **última resposta da IA** (cortada em ~600 caracteres) como resumo.
- **Retomar:** para cada sessão o Guardian gera um pequeno atalho `.cmd` em `D:\CEREBRO\_retomar\` que abre o terminal na pasta do projeto e roda `codex resume <id>` / `claude --resume <id>` / o equivalente do Hermes. A nota linka esse atalho; clicar no Obsidian executa (o Obsidian pede confirmação na 1ª vez).
- Mudança consciente: o Guardian hoje promete não guardar texto de conversa. Isso passa a guardar **só a última resposta resumida**, apenas no seu PC, dentro do cofre. Atualizar o `PRIVACY.md`.

### 5. Resumo universal
- Montado a partir de: última IA (item 4), README/notas do projeto e o que o Guardian já extrai (foco, próximos passos).
- Reforço para o futuro: uma regra curta nos arquivos globais das IAs (`~\.codex\AGENTS.md`, `~\.claude\CLAUDE.md`, skill do Hermes): *"ao terminar uma tarefa, escreva 3–5 linhas em `D:\CEREBRO\Caixa de entrada\<projeto>.md`"*. O Guardian junta isso no resumo universal. As IAs **não** escrevem dentro das pastas dos projetos.

### 6. Painel principal (`Dashboard.md`)
- **Em andamento** (mexido nos últimos 7 dias), **Dá pra retomar** (parado 7–90 dias, com botão de retomar), **Concluídos**, **Arquivo — não mexer** (recolhido).
- Filtro por disco, tipo (código/IA/música/vídeo/design/docs) e última IA.
- **Árvore** (`Mapa.md`): disco → área → projeto, com links. O Graph View do Obsidian mostra as ligações de graça. Um Canvas visual fica para depois, se fizer falta.

### 7. Duplicados e análise noturna
- Duplicados: candidatos por nome parecido + tamanho igual; confirmação por hash só em arquivos locais (nunca no Drive em nuvem).
- Depois da varredura das 03:00, uma IA (Codex `exec`, que já está instalado; Hermes se preferir) lê o resumo do inventário e escreve `Sugestões.md`: unir, descartar, problemas. **Só texto, nenhuma ação.**

## Decidido pelo Paixão
- Abordagem A (completar o Guardian).
- Escopo: tudo (não só IA), Downloads ignorado, foco D:, F:, Drive.
- Mostrar última IA, data, resumo e clique para voltar à sessão.

## Minhas escolhas (pode corrigir)
- Cofre em `D:\CEREBRO`; "arquivo" = sem mudança há mais de 1 ano; varredura às 03:00; análise noturna pelo Codex; ChatGPT web fica para v2; Canvas fica para v2.

## Para quem for construir
- Mudanças no repositório `kinzart/project-guardian` (Node 18+, sem dependências novas se possível), com testes no padrão `node --test` existente, versão 1.1.0.
- Conferir no PC o formato das sessões do Hermes e do Claude Code antes de escrever os leitores.
- Instalar no PC só depois do PR revisado; configurar `vaultPath` e raízes no `guardian.config.json`.
