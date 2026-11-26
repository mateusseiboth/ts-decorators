# Changelog

Da versão mais nova para a mais antiga. As entradas marcadas como **base** vieram da base comum
de que este pacote nasceu (mesma origem, linhas separadas desde julho de 2026) e chegam aqui
juntas na 2.0.0-rc.1. A versão entre parênteses é a da base, para quem compara as duas linhas.

## 2.0.0-rc.41 (2026-11-26)

- **Ordenar e filtrar por campo de variante através de relação (Prisma 8).** Com a relação do
  contrato apontando para a base de um model discriminado (`aluno Vinculo`, com
  `@@discriminator(tipo)`) e o campo numa variante guardada na mesma tabela
  (`@@base(Vinculo, "ALUNO")`, com `nome`), `orderBy=aluno.nome` e `aluno.nome=contains:x` passam
  a funcionar no `executeOrmQuery`, no `applyOrderBy` e no `applyWhere`. O acessor que o ORM
  entrega pela relação é o da base, sem os campos da variante; o pacote monta a coluna da variante
  com o alias da tabela relacionada e as comparações como expressão crua booleana. Conferido no
  `@prisma/orm-postgres` 8.0.0-rc.25. Variante em tabela própria continua com o erro do ORM.
- Fakes: `FakeModelMeta` ganha `variants`, `base` e `table`, e o contrato fake sai com `storage`;
  o `raw.sql` do `fakeDb8` aceita `.returns(codec)`.

## 2.0.0-rc.40 (2026-11-26)

- **`toTemplate` no tipo do `raw.sql` do Prisma 8.** Os valores saem tipados como `RawSqlValue`
  (`number | bigint | string | boolean | Uint8Array`, o `RawSqlLiteral` do Prisma 8):
  `db.raw.sql(...toTemplate(trecho))` compila sem cast. `toTemplate<RawSqlInterpolation>(trecho)`
  usa o tipo do próprio Prisma, quando o projeto quiser.
- **`null` interpolado vira `NULL` no texto** (a interpolação crua do Prisma 8 não aceita `null`
  como parâmetro). `undefined` interpolado agora lança na montagem, com a mensagem de usar `null`
  ou `EMPTY_SQL`; antes chegava ao Prisma e falhava lá.
- `sqlNullable(valor, "uuid")`: `CAST(NULL AS uuid)` quando falta, `CAST($n AS uuid)` quando
  existe. O tipo é conferido como nome de tipo, nunca vira texto livre.

## 2.0.0-rc.39 (2026-11-26)

- **Container: construtor herdado.** A classe sem construtor próprio (`class Registry extends
  BaseRegistry {}`) é resolvida pelos parâmetros e pelos `@Inject(token)` da classe-mãe mais
  próxima que declara o construtor, sem repetir o construtor em cada subclasse. Cada nível lê só
  a própria metadata: a subclasse com construtor próprio usa o dela, e o `@Inject` da base não vale
  para o mesmo índice da subclasse. Construtor que só repassa os argumentos, sem metadata (o de uma
  classe que envolve outra), também injeta pela classe envolvida.

## 2.0.0-rc.38 (2026-11-26)

### Quebra compatibilidade

- **O `sharp` saiu do pacote.** A compressão do brasão do relatório usa só o `Bun.Image` (Bun >=
  1.4): redimensiona para dentro da caixa sem aumentar, grava WebP com qualidade e lê PNG, JPEG,
  WebP, GIF, BMP, TIFF, HEIC e AVIF. SVG deixa de ser aceito (o `Bun.Image` não rasteriza): o
  relatório sai sem o brasão e o motivo vai para o log. Sem `Bun.Image` (Bun antigo), o brasão
  segue no formato original. Quem instalava o `sharp` só para o pacote pode removê-lo.
- **`respond` roda também com `undefined`.** No `applyControllerRoutes` (rc.36), o `respond` só
  rodava com retorno definido; agora roda sempre que ninguém respondeu e o handler não chamou
  `next`, e o projeto decide o 204.

### Novo

- `folderRouter(app, pasta, { container })`, `@RegistryRouter({ container })`: cada
  `registry(router, { container })` recebe o container do app (o global, sem a opção).
- `new RouteBuilder(router, middlewares, { respond })`: o mesmo `respond` para as rotas do
  `declareRoutes()`, depois que o último handler termina (depois do commit). Vale nos builders do
  `extend`.
- `RouteBuilder.get(path, { doc }, ...handlers)` (e os demais verbos): opções da rota no segundo
  argumento. O builder anota cada rota (`definitions()`), e o `listRouteDefinitions(registry)`
  devolve o `@Rest`, os verbos do controller e o `declareRoutes()` juntos.
- `reviveDates` e `mapRow` no `executeOrmQuery` e no `executePrismaQuery`: as datas saem como
  `Date` (o padrão continua o texto ISO) e cada linha vira o tipo do domínio.

## 2.0.0-rc.37 (2026-11-26)

- **O aviso "LEGACY" saiu do pacote.** O ts-decorators é do modo legado (`experimentalDecorators`
  + `emitDecoratorMetadata`): nenhum decorator avisa no boot. `warnLegacy`, `clearLegacyWarnings` e
  o `setLegacyWarnings` da rc.36 continuam exportados como no-op deprecated.
- O `@ModelTagged` continua registrando pelo `static tag` no legado; no contexto TC39, espera o
  inicializador da classe (rc.35).

## 2.0.0-rc.36 (2026-11-26)

Rotas, container e transação para backends com registry e controllers decorados.

- `Transactional(prisma)` (middleware) chama o injetor mesmo sem `res.locals.entity` quando ele é
  contextual (`configureTenantGucs`): o super admin recebe as GUCs. `markContextualInjector`
  marca um injetor próprio do mesmo jeito.
- `mergeParams` no `folderRouter`, no `@RegistryRouter` e no `@GlobalRouter`: os params do
  caminho de montagem (`/academias/:academiaId`) chegam às rotas.
- `applyControllerRoutes({ respond })`: responde com o que o método devolveu, depois do último
  handler (o `wrap` que abre e fecha a transação), ou seja, depois do commit. Não roda quando o
  método devolve `undefined` ou já respondeu.
- `listRouteDefinitions(registry)`: as rotas do `@Rest` do registry e dos verbos do controller, com
  método, caminho, handler e opções; `RouteOptions.doc` (`summary`, `tags`, `body`,
  `responses`...) para o projeto gerar o OpenAPI.
- `setLegacyWarnings(false)`: o projeto que usa o modo legado de propósito (o `@Injectable`
  depende do `design:paramtypes`) desliga o aviso "LEGACY".
- `RouteBuilder`: `router`, `defaultMiddlewares` e `mergeHandlers` são `protected`, e o `extend`
  devolve a subclasse.
- Container: `createToken<T>(nome)` e `@Inject(token)` para dependência que não é classe;
  `register`/`get` aceitam token. `createContainer()` cria um container próprio (por app, por
  teste), sem `container.clear()`.
- `GlobalRouterApp`: base que declara o `initializeRoutes` que o `@GlobalRouter` acrescenta, para
  o projeto chamar sem cast.

## 2.0.0-rc.35 (2026-11-26)

Listagem para multi-tenant com RLS por várias GUCs.

### Quebra compatibilidade

- **O id desempata a ordem.** O `getOrderBy` acrescenta `{ id: "asc" }` ao fim da ordem pedida e,
  sem ordem na query, ordena por `id` (antes não publicava `orderBy`). Vale para model que tem o
  campo `id`; `static orderTieBreaker = "coluna"` troca a coluna e `false` desliga.

### Novo

- `createPaginate({ required, defaultOffset, maxOffset })`: paginação obrigatória (a lista não
  sai inteira sem o cabeçalho), padrão e teto configuráveis; `offset` acima do teto responde 400
  em `errors[{ path: "offset" }]`. Por model (`static paginate = {...}`) ou por rota
  (`withPrismaOptions(Model, { paginate })`). O `getPaginate` continua igual.
- `@ModelTagged` no TC39 enxerga o `static tag = N`: sem a tag na hora do decorator, o registro
  espera o inicializador da classe.
- `configureDateFilter({ timeZone: () => fuso })`: o dia do filtro de data do `getWhere` vale no
  fuso informado (o da academia, pelo contexto). Data com hora é o instante nesse fuso.
- `@Field("uuid")`: valor que não é uuid no filtro responde 400 no campo, em vez do erro 22P02 do
  Postgres; `contains` em uuid vira igualdade.
- Busca em várias colunas: `static search = { fields: ["nome", "cpf"], param?: "busca" }` no model.
  `?busca=termo` vira um OU de `contains` sem diferenciar maiúsculas, com o `normalize` de cada
  coluna.
- `summary: { sum: ["valor"] }` no `executePrismaQuery` e no `executeOrmQuery`: `data.resumo` com
  `count` e as somas sobre o filtro inteiro, não sobre a página.
- `setTenantScope(fn)`: o escopo do tenant nas chaves do cache de contagem (`countTtlMs`) e do
  `@Cacheable`. O padrão continua a `entity` do contexto.
- `applyTransactionGucs(tx, gucs)`, `createGucsInjector` e `configureTenantGucs(resolve)`: RLS por
  várias GUCs por requisição (`app.conta_id`, `app.academia_id`...), nomes e valores
  parametrizados num comando só, no Prisma 7 e no 8. `configureTenantGucs` liga o injetor das
  transações e o escopo do tenant juntos.

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
