# Changelog

Da versão mais nova para a mais antiga. As entradas marcadas como **base** vieram da base comum
de que este pacote nasceu (mesma origem, linhas separadas desde julho de 2026) e chegam aqui
juntas na 2.0.0-rc.1. A versão entre parênteses é a da base, para quem compara as duas linhas.

## 2.0.0-rc.34 (2026-11-26)

### Paginação, filtro e camada de dados

- **Quebra:** `getPaginate` responde 400 (`errors: [{ path: "page" | "offset", message }]`) para
  `page`/`offset` zero, negativo ou não numérico. Antes ia para o Prisma (500) ou devolvia total
  negativo. O que o `parseInt` lia continua valendo.
- **Quebra:** listagem vazia sai no formato da cheia, `{ data: { data: [], paginacao } }`, no
  `executePrismaQuery`, no `executeOrmQuery` e sem paginação. Antes era `{ data: [], paginate }`.
  Página além da última traz o total real.
- **Quebra:** o `logger` escreve uma linha JSON por evento em produção (`NODE_ENV`/`DEPLOY_ENV`
  `production`), com `trace_id`, `request_id`, `tenant` e `user_id`, e mascara chaves sensíveis.
  Fora de produção a saída é legível. `LOG_FORMAT=pretty|json` força um dos dois; `LOG_LEVEL`
  vence o `TS_COMMONS_LOG_LEVEL`, que continua valendo.
- `sql`, `joinSql`, `EMPTY_SQL`, `toTemplate` e `SqlFragment`: SQL cru do Prisma 8 em pedaços.
  `configurePrisma8` aceita `param` para interpolar data.
- `assertWhereFitsContract` e `InvalidFilterError` (400): nulo em coluna obrigatória.
- `prepareRead`, `shareReads` e `readShared`: leituras repetidas do Prisma 8.
- `@Field({ encrypted, normalize })`, `configureEncryption`, `reencryptColumn` e afins: campo
  cifrado (AES-256-GCM) e normalizado, também no filtro do `getWhere`.
- `updateById`, `readIfMatch` e `OptimisticLockError` (409): trava otimista pelo `updated_at`
  com `@DAOFor(tag, { optimisticLock: true })`.
- `afterCommit(tx, fn)`: o `runInTransaction` roda os ganchos depois do commit e os descarta no
  rollback; o savepoint do `@TransactionalClass` descarta só os da escrita desfeita.
- `setHandlerContext(get, require, { run, transactionKeys })`, `hasTenant` e
  `runWithHandlerContext`.
- Métricas do pacote por `@opentelemetry/api` (peer opcional, carregado só quando existe):
  `recordMetric`, `incrementMetric`, `registerGauge`, `getTenantLabel` e os `BUCKETS_*`.
- Fakes: `FakeModelMeta.required` (colunas NOT NULL no contrato) e `withoutOrdenacao` no lugar de
  `semOrdenacao`, que continua aceito.

### Resiliência e operação

- `@AfterCommit(evento)`: o evento sai só depois do commit e é descartado no rollback.
- `@Retry`/`withRetry`, `@Timeout`/`withTimeout`/`getTimeoutSignal`, `@CircuitBreaker`/
  `withCircuitBreaker` e `@SingleFlight`/`withSingleFlight`.
- `@AdvisoryLock`/`withAdvisoryLock`: `pg_advisory_xact_lock` (Prisma 7 e 8) e `GET_LOCK` (MySQL,
  Prisma 7) na transação em uso; `AdvisoryLockTimeoutError` no `waitMs`.
- `@IdempotentMethod`/`withIdempotency` para job e consumidor de fila.
- `enableGracefulShutdown`, `@OnShutdown`, `createDrainRouter` e `rejectWritesWhenDraining`
  (drenagem com o servidor no ar), `@HealthCheck`/`createHealthRouter` (`/health`, `/ready`).
- `@Timed`, `@Counted`, `@Deprecated`/`deprecatedMiddleware`, `@Config`/`defineConfig`.
- `@Trace`/`withSpan`: span do OpenTelemetry em volta do método (peer opcional).
- **Correção:** método `async` decorado continua `async` (os decorators de classe que só envolvem
  `AsyncFunction` deixavam o método fora da transação).
- **Correção:** decorar a subclasse não muda mais a lista da classe base (`@Cron`, `@Listen`,
  `@Processor`, `@MaskSensitive`, `@RegistryRouter` no padrão legado).

### Observabilidade (`@mateusseiboth/ts-decorators/observability`)

- `bun --preload @mateusseiboth/ts-decorators/observability/preload` sobe o SDK do OpenTelemetry
  (traces e métricas por OTLP, propagação `traceparent`/`X-Trace-Id`, `fetch` instrumentado,
  console em JSON). `observeHttp()` completa o span da requisição, grava
  `http.server.request.duration` e escreve uma linha de acesso por requisição.
- Métricas do próprio pacote (fila, banco com `createPrisma8Metrics`, trava, idempotência,
  permissão, auditoria, relatório, drenagem, saúde e runtime com `registerDefaultMetrics`).
- Os pacotes `@opentelemetry/*` do SDK passam a ser dependências do pacote.

### Permissões

- `@RequiresPermission`, `authorize`, `isAllowed`, `isAuthorized`, `decideRouteAccess`, catálogo
  (`getPermissionCatalog`) e motor de condições (`evaluateConditions`). Cada app chama
  `configurePermissions` uma vez no bootstrap; sem ela, toda checagem lança.

### Filas, auditoria, relatórios e rotas

- `@Processor(fila, { perTenant: { concurrency, key } })`: concorrência justa por tenant, contada
  no armazenamento. O `ReportEngine` aceita o mesmo `perTenant`. O `SqliteQueueAdapter` ganha a
  coluna `tenant` sozinho.
- `SqliteQueueAdapter`: retenção dos jobs terminados (`completedRetentionMs`,
  `failedRetentionMs`, `purgeFinished`).
- `AuditLogger`: um arquivo por mês (`rotate`, `retention`), `sensitiveKeys`, e `authorization`
  e `cookie` mascarados. `@Auditable({ read: true })` registra leituras (`flushAuditReads`).
- Middleware `Idempotent`: cabeçalho `Idempotency-Key`, respostas `{ message, code }` em
  português, 422 para a mesma chave com outro pedido, `mode: "optional"` e `methods`.
- `folderRouter`: o `_middlewares.ts` da pasta vale para a pasta e as de baixo;
  `inheritFolderMiddlewares = false` na rota que não herda.
- Relatórios: **quebra:** o PDF sai em A4 (`pageFormat: "Letter"` volta ao tamanho de antes);
  PDFs prontos anexados sem rasterizar (`getPdfAttachments`); relatório sai sem brasão quando o
  download falha; `groupBy`, `extenso` e `formatCpfCnpj` nos modelos.
- Studio reescrito (galeria de modelos, autocompletar por contexto, painel de problemas, PDF real,
  paleta Ctrl+K). `STUDIO_ALLOWED_ORIGINS` limita com quais sistemas ele conversa.

### Quebras desta versão (resumo)

- `getPaginate` 400 para `page`/`offset` inválido; listagem vazia no formato da cheia.
- `logger` em JSON em produção (`LOG_FORMAT=pretty` volta ao texto).
- PDF dos relatórios em A4.
- Middleware `Idempotent`: mensagens e códigos novos (`IDEMPOTENCY_KEY_*`) e 422 no reuso da chave.
- O rótulo/campo de tenant nas métricas e no log se chama `tenant`.

## 2.0.0-rc.1 (2026-10-16)

Porte completo da base comum (até a 2.0.0-rc.15 dela) para este pacote, mantendo tudo o que só
existia aqui (`@Rest`, `@Get`/`@Post`/..., `AllRouters`, estratégia de tenant injetável,
middlewares que publicam no contexto). O destaque é o **Prisma 8** ao lado do Prisma 7.

### Quebra compatibilidade

- **Tenant padrão parametrizado.** `defaultCompanyIdInjector` (e com ele `addCompanyIdToTransaction`,
  `TransactionalHandler` e `withTransaction`) roda `SELECT set_config('my.company_id', $1, true)`
  com o id como parâmetro, no lugar de `SET LOCAL "my.company_id" = ${Number(id)}`. O id vai como
  texto: UUID deixa de virar `NaN`, e o id numérico grava o mesmo `"42"`. Quem conferia o SQL
  exato em teste precisa atualizar a expectativa. Na transação do Prisma 8 o mesmo comando vai
  como plano cru (`db.raw.sql`) e exige `configurePrisma8`. Objeto que não é transação de nenhum
  dos dois agora falha com mensagem clara.
- **`getWhere` responde 400 para valor inválido** (`1,5` ou `abc` em campo numérico, `31/02/2026`
  em data), com o campo em `errors[].path`. Antes o filtro rodava com um valor que ninguém pediu.
- **Intervalo numérico vira uma condição só.** `?codigo=1-5` gera `{ gte: 1, lte: 5 }` em vez de
  um `equals` por número. O resultado da consulta é o mesmo; quem inspeciona o `where` ajusta.
- **Operadores que viravam igualdade agora filtram o que o nome diz:** `greaterThanOrEqual`,
  `lessThanOrEqual`, `notIn`, `notInRange`, `notNull`, `containing`. `in:1,2,3` em campo numérico
  deixou de virar `[123]`; `-5` é o número negativo.
- **Filtro por data no dia certo.** A igualdade cobre o dia informado no fuso do processo, e
  `parseDate("2026-01-15")` é a meia-noite local (antes lia em UTC).
- **Decorators de classe enxergam métodos herdados.** `@Cacheable`, `@Auditable` e
  `@TransactionalClass` passam a envolver o `get`, `create`, `update` e `deleteById` herdados do
  controller base. Confira os controllers que herdam esses métodos.
- **`RouteBuilder.withPrismaOptions`** inclui o `getColumns` (`?fields=`), e `makePrismaOptions`
  devolve `columns` quando pedido (o `executePrismaQuery` consome a chave).
- **Logs de rota.** `folderRouter`, `@GlobalRouter` e `@RegistryRouter` não imprimem mais banner
  com `console.log`: o detalhe vai em `logger.debug` e cada pasta varrida vira UMA tabela em
  `logger.info`. `AllRouters` continua com `path`, `file`, `globalMiddlewares` e
  `routeMiddlewares`, e ganhou `endpoints`.
- **Prefixo dos logs:** `[@mateusseiboth/ts-commons]` passou a `[@mateusseiboth/ts-decorators]`.
- **`SqliteQueueAdapter`** acrescenta a coluna `lockedAt` na tabela existente (sozinho, por
  `ALTER TABLE`).
- **Tipos.** `PrismaClientLike` virou a união `Prisma7ClientLike | Prisma8ClientLike`;
  `CompanyIdInjector` recebe `CompanyId` (`string | number`); `AllRouters` é
  `Record<string, MountedRouter>`.

### Novo neste pacote

- `defaultCompanyIdInjector` serve Prisma 7 e Prisma 8, por strategy map pela forma da transação.
- `rawParamStatementPlan` monta plano cru do Prisma 8 com parâmetros (`${valor}` vira `$n`).
- O middleware `Transactional(prisma)` aceita `companyIdInjector` por rota, e
  `setTransactionalCompanyFn(null)` desliga a função global.
- `getColumns` também publica no contexto do request; `publishRequestValue` é exportado.
- `fakeTx8` guarda o plano inteiro de cada comando cru em `plans`.
- `applyWhere`: `{ equals, mode: "insensitive" }` em coluna de texto vira `ilike` do termo inteiro
  (escapado), como o Prisma 7 comparava. Antes virava `eq` e diferenciava maiúsculas em silêncio.
  `escapeLike` é exportado, para quem monta o `ilike` nativo.
- `FakeCollection`: `aggregate` responde `sum`/`avg`/`min`/`max` (por `agregados`, pelo nome do
  resultado, `null` sem valor) e registra o pedido em `calls`; `with(fragmento)` existe, como na
  coleção real.
- O próprio repositório passa a rodar a regra `ts-decorators/no-enum` no lint.

### Incorporado da base

#### Prisma 8 (base 2.0.0-rc.1 a rc.15)

- **Suporte ao Prisma 8 ao lado do Prisma 7.** Registre a fachada uma vez com
  `configurePrisma8({ db, and, or, not })`. `setPrismaClient` aceita o client do 7 e a fachada do
  8, e `runInTransaction` abre a transação no que estiver registrado.
- **`executeOrmQuery`**, o irmão do `executePrismaQuery` para coleção do Prisma 8: mesmas opções e
  mesma resposta paginada. Sem paginação faz uma consulta só. `applyWhere`, `applyOrderBy`,
  `applyProjection` e `applyQueryOptions` traduzem filtro, ordenação e colunas; `countRows`,
  `readRows` e `collectionMeta` são as peças.
- **Fakes de teste** em `@mateusseiboth/ts-decorators/testing`: coleção, transação e fachada de
  mentira, com escritas registradas, `groupBy` e `setFakeWriteHook` para reproduzir o que o
  middleware do projeto acrescenta na escrita.
- **`resetPrisma8`** volta para a configuração de bootstrap (`configurePrisma8(cfg, { base: true })`);
  `clearPrisma8` esquece tudo.
- **`numericAsNumber`**: coluna `numeric` volta como `number`, inclusive nas relações; na escrita
  e no filtro o número vira o texto que o Prisma 8 exige.
- **Enums pelo rótulo** (`enums` no `configurePrisma8`): rótulo vira valor na escrita e no filtro,
  valor vira rótulo na leitura.
- **Ordenar por relação to-one** (`?orderBy=contribuinte.name`) com `ast: { SubqueryExpr, ProjectionItem }`.
- Correções: inteiro em coluna `int8` vira `bigint`; ordenar por coluna `Boolean` funciona;
  `contains`/`startsWith`/`endsWith` em coluna uuid viram igualdade; o codec é lido em
  `field.codec` (Prisma 8 rc.17) e em `field.returnType.codec` (rc.18).
- Statements crus nos dois Prismas: `runStatement`, `rawStatementPlan`, `rawRowsPlan`; SAVEPOINT do
  `@TransactionalClass` e `before` do `@Auditable` funcionam na transação do 8.
- Datas do Prisma 8 (`Temporal`) serializadas no mesmo ISO do Prisma 7: `temporalToIso`,
  `temporalToDate`, `datesFromTemporal`, `encodeForCodec`, `decodeForCodec`,
  `encodeRowForCollection`, `decodeRowsForCollection`, `fieldCodecs`.

#### Filas (base 2.0.0-rc.7, rc.11, rc.12)

- `listQueues`, `getQueueStats`, `getQueueJobs`, `retryQueueJob`, `removeQueueJob`, `purgeQueue`
  para painel de administração e health check.
- `maxPerKey` no `@Processor`: a mesma chave pode ter até N jobs em andamento (padrão 1).
- Job preso em `processing` (processo caiu no meio) volta para a fila depois de `staleAfterMs`
  (padrão 60 s); dois processos na mesma tabela SQLite não rodam o mesmo job (`claim`).

#### Rotas e middlewares (base 1.5 a 2.0.0-rc.13)

- `getColumns` (`?fields=id,name`): o cliente pede só as colunas que usa, e a projeção só
  ESTREITA o `select` do DAO (`applyColumnProjection`, `buildSelectFromFields`).
- `compressResponse`: gzip/brotli na resposta, brotli em qualidade de API.
- `Idempotent`: chave por dono da requisição; cliente que derruba a conexão não derruba mais o
  processo (a repetição recebe 409 pedindo reenvio).
- Registro de rotas: `getRegisteredRoutes`, `endpointsOf`, `formatRoutesTable`, `clearRegisteredRoutes`.
- `isNull` e `notNull` no `buildWhereFromQuery` e no `createWhereCondition`.

#### Relatórios e Studio (base 1.4 a 2.0.0-rc.7)

- Motor de relatórios (`ReportEngine`, `createReportRouter`, `SqliteTemplateStore`, formatos PDF e
  JSON por strategy, worker de PDF com Playwright, numeração contínua de páginas em lotes,
  streaming de dados). Peers opcionais: `handlebars`, `playwright`, `sharp`, `pdf-lib`.
- Compressão de imagem com `Bun.Image` quando disponível, sem precisar do `sharp`.
- Relatório que falhava no worker não fica mais preso na fila; `ReportEngine.health()`.
- Binário `ts-decorators studio [--port 4123]`: editor de templates com preview em tempo real.

#### Modelos e datas (base 1.10.0, 2.0.0-rc.12)

- `@Field` e `@AutoConvert` aceitam os tipos do `Temporal` pelo nome ou pelo construtor
  (`parseTemporal`, `parsePlainDate`, `parseZonedDateTime`...), preservando o fuso.
- `parseDate` não troca de dia e devolve `null` para o que não é data, em vez de lançar.

#### Lint

- Plugin do oxlint `@mateusseiboth/ts-decorators/oxlint`, regra `ts-decorators/no-enum` .

#### Já presentes aqui antes do porte

A base 1.11.0 e 1.12.0 (cache de metadata, log por nível, `countTtlMs`, `AuditLogger` em lote,
padrões históricos de volta, `setFreezeMetadata` opcional) correspondem à 1.3.0 e 1.3.1 deste
pacote.

## 1.3.1 (2026-09-01)

- Os padrões da 1.3.0 voltam ao comportamento histórico: `executePrismaQuery` sempre consulta o
  count (`deriveTotal: true` ou `setDeriveTotalDefault(true)` para deduzir), `@TransactionalClass`
  volta a `"always"` (`setSavepointPolicy("auto")` liga a economia), `@Auditable` volta a buscar o
  registro antigo (`{ captureBefore: false }` desliga) e o congelamento de metadata vira
  `setFreezeMetadata(true)`.

## 1.3.0 (2026-09-01)

- Cache de metadata, plano de conversão do `@AutoConvert`, log por nível
  (`setLogLevel`, `TS_COMMONS_LOG_LEVEL`) e menos idas ao banco na listagem.
- `getWhere`, `getOrderBy` e `getPaginate` publicam também no contexto do request.
- oxlint + oxfmt no repositório.

## 1.2.7 (2026-08-14)

- Estratégia de company id injetável: `setCompanyIdInjector`, `defaultCompanyIdInjector`,
  `noopCompanyIdInjector`, `resetCompanyIdInjector`, e `companyIdInjector` por rota.

## 1.2.6 (2026-07-11)

- Chave de semáforo (`keyOf`) no `@Processor`.

## 1.2.5 (2026-07-05)

- `AllRouters`: toda rota montada pelo `folderRouter`, por caminho.

## 1.2.4 (2026-07-04)

- Rotas declarativas: `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`, `@Head`, `@All`,
  `@Rest`, `applyControllerRoutes`, `getControllerRoutes`, `getRestRoutes`.

## 1.2.3 (2026-06-30)

- `@Mutex`, `@Semaphore`, `@Cron`, `@Queue`/`@Processor`, `@Emit`/`@Listen`, `@MaskSensitive`,
  `@RequiresRole`, ciclo de vida do container (`@Singleton`, `@Scoped`, `@Transient`).

## 1.2.0 a 1.2.2 (2026-05 a 2026-06)

- Roteamento por arquivos, handlers (`withTransaction`, `compose`, `Audit`), relações to-one e
  to-many no `@Field`, correção do `@Validate`.

## 1.1.0 (2026-04-01)

- Primeira versão.
