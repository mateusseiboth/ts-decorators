# Studio — editor visual de templates de relatório

`ts-decorators studio [--port 4123]` sobe um editor local de templates Handlebars
com preview em tempo real, pensado para usuários **não técnicos** (setor de
qualidade) montarem relatórios sem escrever código na mão.

## Como funciona

- **Página única** servida por [src/studio/page.ts](../src/studio/page.ts) —
  auto-contida, sem CDN. Layout estilo Google Docs: barra superior, barra de
  ferramentas, painel de dados à esquerda, editor no centro e preview em
  "folha A4" à direita.
- **Servidor local** em [src/studio/server.ts](../src/studio/server.ts):
  - `POST /api/render` — compila o HBS no servidor com os helpers default.
  - `GET /api/helpers` — catálogo de helpers (alimenta o menu "ƒ Funções").
  - `POST /api/fetch-data` — proxy para a rota de dados do app (evita CORS).
  - `POST /api/export` — proxy para a rota de templates do app.

## Fluxos para o usuário

1. **Dados**: "Colar JSON" (cola qualquer JSON de dados) ou "Conectar ao
   sistema" (URL + headers + filtros). Os campos aparecem numa árvore à
   esquerda com tipo e valor de exemplo.
2. **Arrastar e soltar**: arrastar um campo da árvore para o editor insere
   `{{campo}}` (o navegador insere no ponto do drop nativamente — o dragstart
   só define `text/plain`). O botão **+** insere na posição do cursor. Listas
   arrastadas viram blocos `{{#each}}`; campos de item viram `{{this.campo}}`.
3. **Assistentes** (escrevem o Handlebars sozinhos):
   - **▦ Tabela**: escolhe a lista + colunas → gera `<table>` com `{{#each}}`,
     coluna `#` opcional (`{{index1 @index}}`) e linha de total opcional com
     `{{number (sum lista "campo")}}`.
   - **⑂ Condicional**: campo + operador + valor → `{{#ifCond a "op" b}}`,
     com `{{else}}` opcional. Operadores sem valor: `vazio`/`preenchido`.
   - **Σ Cálculo**: soma/média/mín/máx/contagem de um campo numérico de uma
     lista, com formatação em moeda opcional (subexpressão
     `{{currency (sum ...)}}`).
4. **Autosave** em `localStorage` (template, dados, URLs) — fechar o navegador
   não perde o trabalho.

## Decisões técnicas / observações

- **Helpers em fonte única**: [src/report/templateHelpers.ts](../src/report/templateHelpers.ts)
  registra os helpers tanto no worker de PDF
  ([pdf.worker.ts](../src/report/worker/pdf.worker.ts)) quanto no Studio.
  **Todo helper novo deve nascer lá** — registrar só num lado faz o template
  exportado quebrar do outro. `REPORT_HELPER_DOCS` (mesmo arquivo) documenta
  cada helper e alimenta o menu do editor; o teste
  `report.templateHelpers.test.ts` garante que todo helper documentado está
  registrado e que o snippet compila.
- **Sandbox do preview**: o iframe usa
  `sandbox="allow-scripts allow-same-origin"`. Sem `allow-scripts` o Chrome
  bloqueia scripts dos templates com *"Blocked script execution in
  'about:srcdoc'…"*. É aceitável aqui porque o Studio é ferramenta local de
  desenvolvimento renderizando conteúdo do próprio usuário.
- **Drop nativo em textarea**: navegadores inserem `text/plain` arrastado na
  posição do cursor de drop em `<textarea>` sem JS extra — por isso o editor
  continua sendo um textarea (simples e confiável) em vez de contenteditable.
- **Syntax highlight por overlay**: um `<pre id="editorHl">` colorido fica
  atrás do textarea, que tem `color: transparent; caret-color` visível. Os
  dois precisam de métrica idêntica (fonte, padding, `white-space: pre-wrap`,
  `overflow-wrap`) e o scroll é sincronizado no evento `scroll`. Tokens: tags
  (verde), atributos (laranja), strings (azul, com `{{...}}` realçado por
  dentro), comentários (cinza), expressões HBS (roxo) e blocos
  `{{#…}}/{{/…}}/{{else}}` (vermelho). Mantém o drop nativo do textarea —
  motivo de não usar contenteditable/CodeMirror.
- **Backslashes no script client**: `page.ts` embute a página num template
  literal TS, que consome um nível de escape — toda regex/`\n` do script
  client é escrita com `\\`. O teste do Studio verifica a regex servida.
- O editor client-side evita template literals/`${}` porque a página inteira
  vive dentro de um template literal TS em `page.ts`.

## Helpers disponíveis

| Helper | Uso | Descrição |
| --- | --- | --- |
| `currency` | `{{currency valor}}` | Moeda BRL |
| `number` | `{{number valor}}` | Número pt-BR, 2 casas |
| `percent` | `{{percent valor}}` | Percentual |
| `formatDate` / `formatDateTime` | `{{formatDate data}}` | Datas pt-BR ("" se inválida) |
| `dateNow` | `{{dateNow}}` | Data/hora atual |
| `uppercase` / `lowercase` | `{{uppercase texto}}` | Caixa alta/baixa |
| `coalesce` | `{{coalesce valor "—"}}` | Primeiro valor preenchido |
| `sum` / `avg` / `min` / `max` | `{{sum itens "valor"}}` | Agregações (aceita caminho `a.b`) |
| `count` | `{{count itens}}` | Tamanho da lista |
| `math` | `{{math a "+" b}}` | `+ - * / %` (divisão por 0 → 0) |
| `index1` | `{{index1 @index}}` | Linha em base 1 dentro de `each` |
| `ifCond` | `{{#ifCond a "==" b}}…{{else}}…{{/ifCond}}` | Operadores: `== != > >= < <= contem vazio preenchido` |
