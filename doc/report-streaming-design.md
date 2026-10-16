# Design — Streaming de dados nos relatórios (fetch paginado + render em lotes)

## Problema
Hoje o pipeline é **load-all → serializa-tudo → renderiza**:
`ReportProcessor.fetchData()` chama `dataSource.report()` que devolve o **array inteiro**;
`PdfOutputStrategy` coloca isso em `payload.data` e manda pro worker via `postMessage`
(JSON.stringify no main + JSON.parse no worker). O batching (1.4.6) e a Opção B (1.4.7)
resolveram só o **render** (Chromium por parte). O **lado-dados continua carregando tudo**:
bci-imovel de 11.513 imóveis = **~9 GB** no boot do job (medido), e a falha vista
("Renderização excedeu 5min") foi timeout do Chromium **por pressão desses 9 GB + swap**.

Meta: **memória constante também nos dados** — nunca ter o dataset inteiro em memória
(nem no main, nem no worker, nem no JSON de transporte), independente do nº de linhas.

## Ideia central
Puxar os dados **em páginas (cursor)**, renderizar **uma parte por página** e **descartar**
a página antes da próxima. O total geral (Opção B) é **acumulado ao longo das páginas**
(fold), não recalculado sobre tudo. Nunca se materializa a coleção completa.

Restrição dura: **o fetch precisa do main** (Prisma, contexto ALS/RLS, transação); **o render
precisa do worker** (Chromium). Então o main produz páginas e o worker consome — o transporte
entre eles é o ponto de design.

## Contratos novos (todos opt-in; sem eles, comportamento atual intacto)

### 1. Fonte de dados paginada (`ReportDataSource`)
```ts
export interface ReportDataSource {
  report(filters, reportTag, entidade, exercicio): Promise<unknown>;        // atual (fallback)
  posProcessReportData?(...): Promise<unknown>;                             // atual
  // NOVO — streaming opt-in: gera páginas de linhas EM ORDEM ESTÁVEL (cursor).
  reportStream?(
    filters, reportTag, entidade, exercicio,
    pageSize: number,
  ): AsyncIterable<unknown[]>;   // yield de cada página já pós-processada (inclui enrich)
}
```
- Cada `yield` é uma página (ex.: 300 imóveis já com BCI enriquecido **daquela página**).
- **Ordem estável obrigatória** (cursor exige `ORDER BY` no banco — ver "Ordenação").

### 2. Totais em fold (Opção B streaming) — no módulo da view
Hoje a Opção B usa `computeTotals(rows)` sobre tudo. Streaming precisa **acumular por página**
e **formatar no fim** (senão não dá pra somar strings já formatadas):
```ts
export interface ReportRenderModule {
  // ...existentes (buildReportHTML, getBatchWeight, SUPPORTS_BATCHING?, computeTotals?)
  initTotals?(): unknown;                         // acumulador zerado (números crus)
  reduceTotals?(acc: unknown, pageRows: readonly unknown[]): unknown; // soma a página no acc
  finalizeTotals?(acc: unknown): unknown;         // formata p/ exibição (o que a view usa)
}
```
- Não-streaming continua com `computeTotals` (equivalente a `finalize(reduce(init, allRows))`).
- A view segue mostrando o total só na última parte (`isLastBatch`), agora com `finalizeTotals(acc)`.

## Orquestração (transporte recomendado: **staging em disco**)
O `postMessage` de 9 GB é parte do problema. A opção mais simples e robusta é **encenar as
páginas em disco** (o pipeline já usa disco pras partes PDF e pro merge com `pdfunite`):

**Main (`ReportProcessor` + uma nova `PdfStreamingStrategy` ou ramo no `PdfOutputStrategy`):**
1. Abre `reportStream(...)`. `acc = initTotals()`.
2. Para cada página `p`:
   - grava `report/<jobId>.page<N>.ndjson` (uma linha por registro),
   - `acc = reduceTotals(acc, p)`,
   - **libera a página** (sai de escopo).
3. Ao fim do stream, grava `report/<jobId>.manifest.json`:
   `{ pageCount, totals: finalizeTotals(acc), title, filters, header, assinaturas, ... }`.
4. Manda ao worker **só o caminho do manifest** (payload minúsculo).

**Worker (`pdf.worker.ts`):** troca `rowsArr = options.data` (in-memory) por um **loop sobre as
páginas em disco**:
```
para N de 0..pageCount-1:
  rows = readNdjson(page<N>)              // 1 página em memória
  html = buildReportHTML({rows, totals: manifest.totals, isLastBatch: N===last, ...})
  parte<N>.pdf = render(html); apaga page<N>.ndjson e o html
merge(partes) + numeração contínua (pageNumbers.ts) → PDF final
```
Ganho: main segura **1 página**; worker segura **1 página**; transporte é disco (barato),
não RAM. O `getBatchWeight` deixa de cortar (a página já é o lote) — `pageSize` vira o "peso".

> Alternativa considerada: **postMessage conversacional** (main envia página → worker rende →
> ack → próxima). Evita escrever NDJSON, mas exige protocolo com estado/backpressure no
> `ReportWorkerManager` (hoje é one-shot). Mais código e mais risco. **Recomendo o staging em
> disco** pela simplicidade e por reaproveitar o padrão de arquivos já existente.

## Ordenação (cursor)
Paginação por cursor **exige ordenação no BANCO** (não em memória):
`orderBy: [{campo: dir}, {id: 'asc'}]` + `cursor: {id: ultimoId}` + `skip:1` + `take: pageSize`.
- O `orderByFunction` (ordenação em memória de alguns relatórios) **não** funciona com stream —
  esses relatórios precisam ordenar via `ORDER BY` no `reportStream`.
- Incluir `id` como desempate garante cursor estável.

## Mudanças por relatório (só nos que streamam)
Para cada relatório pesado (começando por **bci-imovel**, depois imovel/fiscal/indices/…):
1. **DAO**: implementar o fetch paginado — ex. `getFilteredImovelPage(filters, cursor, pageSize)`
   (reusa o `where` do `getFilteredImovel`, adiciona `orderBy`+`cursor`+`take`) e chamar o
   `enrichImoveisComDados` **por página**. Expor via `reportStream` no `resolveDataSource`
   (em `bootstrap/reportEngine.ts`, hoje o `resolveDataSource` devolve `{report, posProcess}`).
2. **View** (main.ts): `initTotals/reduceTotals/finalizeTotals` (extrai a agregação atual);
   `buildReportData` já é batch-ready (aceita array e usa `totals`/`isLastBatch`).
3. Nada muda no template além do que a Opção B já fez (`{{#if totals}}`).

## Compatibilidade e rollout
- **Totalmente opt-in**: sem `reportStream`, o engine usa o caminho atual (load-all + batch).
- Ordem sugerida: (1) engine — contrato + `PdfStreamingStrategy` + loop de páginas no worker;
  (2) **bci-imovel** como piloto (é o pior caso de dados); medir RSS real (esperado **~1 página
  + Chromium**, algo como poucas centenas de MB, contra os 9 GB de hoje); (3) estender aos
  demais data-heavy.
- Versão: seria uma minor nova do pacote (ex.: 1.5.0 — muda contrato/estratégia).

## Riscos / decisões em aberto
- **Protocolo main↔worker**: o worker hoje recebe 1 mensagem e responde 1. O loop de páginas em
  disco mantém isso (1 manifest → 1 resultado), mas o worker passa a **ler do disco** — mudança
  de origem dos dados. Precisa garantir limpeza dos `.ndjson`/`.page` no `finally` (já há
  `removeJobArtifacts`).
- **Ordenação forçada no banco**: relatórios que hoje ordenam em memória precisam migrar o
  `orderBy` pro `reportStream`. Auditar caso a caso.
- **`pageSize`**: trade-off memória×nº de partes (páginas menores = menos RAM, mais merges).
  Começar em ~300 linhas e medir. Pode ser por-relatório (peso do registro varia: BCI é pesado).
- **Transações longas**: o stream mantém leitura por vários minutos. Usar cursor **fora** de uma
  transação longa (ou snapshot/`ReadCommitted`) pra não segurar lock. O `report()` atual roda em
  `$transaction`; o stream deve paginar com transações curtas por página ou uma leitura sem lock.
- **posProcessReportData**: hoje roda sobre tudo; no stream vira **por página** (ok se for
  transformação por-linha; se depender do conjunto todo, não streama — fica no caminho atual).
- **Totais que não são soma** (ex.: distintos, médias, "maior variação"): fold precisa ser
  associativo. Somas/contagens: ok. Distinct/mediana: exigem estruturas auxiliares (Set/streaming
  quantile) — avaliar por relatório; se inviável, o relatório não streama.

## Resultado esperado
bci-imovel (e afins) deixam de ter o pico de **~9 GB de dados**: memória fica ~**1 página +
Chromium de 1 parte** (ordem de centenas de MB), constante para 10 mil ou 1 milhão de imóveis.
Elimina a falha de timeout por pressão de memória. É a solução de raiz do lado-dados,
complementando o batching (render) e a Opção B (totais).
