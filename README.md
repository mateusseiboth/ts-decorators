# @mateusseiboth/ts-decorators

A collection of **TypeScript decorators**, **Express middlewares**, and **utility functions** for building REST APIs with Bun, Express and Prisma (7 **and** 8), less boilerplate, more joy.

Distribuído como **código-fonte** (`module: index.ts`): roda direto no Bun, sem build. Pontos de
entrada:

| Entrada | Arquivo | Para quê |
| ------- | ------- | -------- |
| `@mateusseiboth/ts-decorators` | `index.ts` | Tudo o que está neste README |
| `@mateusseiboth/ts-decorators/testing` | `src/testing/prisma8Fakes.ts` | Fakes do Prisma 8 para teste sem banco |
| `@mateusseiboth/ts-decorators/oxlint` | `src/oxlint/no-enum.mjs` | Plugin do oxlint (regra `ts-decorators/no-enum`) |
| binário `ts-decorators` | `src/cli/index.ts` | Studio de templates de relatório |

O histórico de versões está no [CHANGELOG.md](CHANGELOG.md). A 2.0 traz mudanças que quebram
compatibilidade: leia [Migrando da 1.x](#migrando-da-1x) antes de subir.

## Install

```bash
bun add github:mateusseiboth/ts-decorators
```

### Peer dependencies

```bash
bun add typescript reflect-metadata express @types/express zod
# opcionais, só para o motor de relatórios:
bun add handlebars playwright pdf-lib
```

### tsconfig.json

**Legacy decorators (o modo do pacote):** o `@Injectable` depende do `design:paramtypes`, que só o
modo legado emite. Nenhum decorator avisa "LEGACY" no boot.

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

**TC39 Stage 3 (TypeScript 5+, without `emitDecoratorMetadata`):**  
Works, but with important restrictions — see the [@Field / @InitFields](#field--initfields) section.

---

## How it all fits together

This package revolves around a **field metadata system** that connects everything:

```
@Field()          → registers the name and type of each field
@InitFields       → initialises the registry on the class (REQUIRED)
@ModelTagged      → puts the class in a global registry keyed by numeric tag
                    (requires @InitFields to have been applied first)

getWhere          → uses the registry + collectFieldTypes to know which
getOrderBy          query params are valid and what type each field is
getColumns

@AutoConvert      → uses getFieldTypes(this) to coerce incoming values
                    (the class or its model MUST have @InitFields + @Field)

collectFieldTypes → uses getFieldTypes + getNestedModel recursively
                    (ALL classes involved MUST have @InitFields)
```

> **Golden rule:** if a field does not have `@Field()`, it does not exist for the system. Without `@InitFields` on the class, no fields are found — no error is thrown, the result is simply empty/ignored.

---

## Table of Contents

- [Install](#install)
- [Migrando da 1.x](#migrando-da-1x)
- [How it all fits together](#how-it-all-fits-together)
- [Middlewares](#middlewares)
  - [getWhere](#getwhere)
  - [getOrderBy](#getorderby)
  - [getPaginate](#getpaginate)
  - [getColumns](#getcolumns)
  - [Idempotent](#idempotent)
- [DI — @Injectable + container](#di--injectable--container)
- [Decorators](#decorators)
  - [@Field / @InitFields](#field--initfields) ← **read this first**
  - [@ModelTagged / @DAOFor](#modeltagged--daofor)
  - [@NestedModel](#nestedmodel)
  - [@AutoConvert](#autoconvert)
  - [@Cacheable / @CacheMethod / @Cached / CacheProvider](#cacheable--cachemethod--cached--cacheprovider)
  - [@RateLimit / @RateLimitMethod](#ratelimit--ratelimitmethod)
  - [@Auditable](#auditable)
  - [@logDecorator](#logdecorator)
  - [Prisma 8](#prisma-8-prismaorm-postgres)
  - [@Transactional / @TransactionalClass](#transactional--transactionalclass)
  - [Company id injection (multi-tenant / RLS)](#company-id-injection-multi-tenant--rls)
  - [@Validate / @WithValidation](#validate--withvalidation)
  - [@Singleton / @Scoped / @Transient](#lifecycle--di--singleton--scoped--transient)
  - [@MaskSensitive / applyMask](#masksensitive--applymask)
  - [@RequiresRole](#requiresrole)
  - [@Emit / @Listen + eventBus](#emit--listen--eventbus)
  - [@Mutex / @Semaphore](#mutex--semaphore)
  - [@Cron](#cron)
  - [@Queue / @Processor + adapters](#queue--processor--adapters)
- [Roteamento por arquivos — @GlobalRouter / @RegistryRouter](#roteamento-por-arquivos--globalrouter--registryrouter)
- [HTTP Routing declarativo — @Get / @Rest](#http-routing-declarativo--get--rest)
- [Boot wiring (handlers)](#boot-wiring-handlers)
- [Performance & logging](#performance--logging)
- [Report Engine](#report-engine)
  - [Adicionando em um projeto (passo a passo)](#adicionando-em-um-projeto-passo-a-passo)
  - [Contrato das views](#contrato-das-views)
  - [Formatos de saída (Strategy)](#formatos-de-saída-strategy)
  - [Modelos por entidade e templates](#modelos-por-entidade-e-templates)
  - [Envs e troubleshooting](#envs-e-troubleshooting)
- [Studio (CLI)](#studio-cli)
- [Plugin do oxlint](#plugin-do-oxlint--ts-decoratorsno-enum)
- [Utility Functions](#utility-functions)
- [Portão de saída (format, lint, typecheck, tests)](#portão-de-saída-format-lint-typecheck-tests)
- [Contributing](#contributing)

---

## Middlewares

`getWhere`, `getOrderBy`, `getPaginate` e `getColumns` escrevem o resultado em `res.locals` E, quando
há um contexto configurado com `setHandlerContext`, no contexto do request também (`ctx.where`,
`ctx.orderBy`, `ctx.paginate`, `ctx.columns`). Projeto que guarda o estado do request no
AsyncLocalStorage lê de lá sem forkar os middlewares. Sem contexto nada muda. O helper é
`publishRequestValue(res, chave, valor)`, para os seus middlewares fazerem o mesmo.

### `getWhere`

Converts Express query params into a Prisma `where` clause, populating `res.locals.where`.

> **⚠️ Required dependencies:**
>
> - The model passed as the 4th argument MUST have `@ModelTagged` (to be in the registry)
> - The model MUST have `@InitFields` (so its fields can be found)
> - Only fields decorated with `@Field()` are recognised as valid filters  
>   — query params for fields without `@Field()` are silently ignored
> - For nested filters (`?street.name=...`), the relation field MUST have `@NestedModel(Model)` AND the related model MUST also have `@InitFields` + `@Field()` on its fields

```ts
import {getWhere} from "@mateusseiboth/ts-decorators";

// Pass the MODEL CLASS (not an instance) — it needs static tag + @ModelTagged
router.get("/", (req, res, next) => getWhere(req, res, next, StreetModel), handler);
// → res.locals.where is ready for Prisma
```

You can pass extra fixed conditions (not from the query) as the 5th argument:

```ts
router.get("/", (req, res, next) => getWhere(req, res, next, StreetModel, {active: true}), handler);
// → appends AND: [{ active: true }] to the generated where
```

**Supported operators** (via `:` prefix):

| Query syntax                     | Condition generated                                                |
| -------------------------------- | ------------------------------------------------------------------ |
| `?name=John`                     | `{ name: { equals: "John" } }`                                     |
| `?name=contains:oh`              | `{ name: { contains: "oh", mode: "insensitive" } }`                |
| `?name=containing:oh`            | same as `contains`                                                 |
| `?name=startsWith:Jo`            | `{ name: { startsWith: "Jo", mode: "insensitive" } }`              |
| `?name=endsWith:hn`              | `{ name: { endsWith: "hn", mode: "insensitive" } }`                |
| `?status=in:1,2,3`               | `{ status: { in: [1, 2, 3] } }`                                    |
| `?status=notIn:1,2`              | `{ status: { notIn: [1, 2] } }`                                    |
| `?age=inRange:18-65`             | `{ age: { gte: 18, lte: 65 } }`                                    |
| `?age=notInRange:18-65`          | `NOT: [{ age: { gte: 18, lte: 65 } }]`                             |
| `?age=greaterThan:18`            | `{ age: { gt: 18 } }`                                              |
| `?age=lessThan:30`               | `{ age: { lt: 30 } }`                                              |
| `?age=greaterThanOrEqual:18`     | `{ age: { gte: 18 } }`                                             |
| `?age=lessThanOrEqual:30`        | `{ age: { lte: 30 } }`                                             |
| `?field=isNull:`                 | `{ field: { equals: null } }`                                      |
| `?field=notNull:`                | `{ field: { not: null } }`                                         |
| `?id=1;2;3`                      | `OR: [{ id: { equals: 1 } }, { id: { equals: 2 } }, { id: { equals: 3 } }]` |
| `?name=startsWith:Jo;Ma`         | the operator carries over to the next `;` values: `OR` of two `startsWith` |
| `?name=!John`                    | `NOT: [{ name: { equals: "John" } }]`                              |
| `?status=!in:1,2` / `in:!1,2`    | `NOT: [{ status: { in: [1, 2] } }]` (`!` works before or after the prefix) |
| `?id=5-10` (numeric field)       | `{ id: { gte: 5, lte: 10 } }` (ONE condition, never expanded)      |
| `?id=-5` / `?id=-5--1` (numeric) | `{ id: { equals: -5 } }` / `{ id: { gte: -5, lte: -1 } }`          |
| `?district.name=Downtown`        | `{ district: { name: { equals: "Downtown" } } }`                   |

Every operator in `OPTIONS_FILTER` has a translation. `contains` / `startsWith` / `endsWith` only exist for `"string"` fields (always case-insensitive); on any other type they fall back to equality.

**Date fields** (`"date"` and the Temporal date types). Values are read with `parseDate`, so both ISO (`2026-01-15`) and Brazilian (`15/01/2026`) formats work, in the time zone of the process:

| Query syntax                                   | Condition generated                                             |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `?createdAt=2026-01-15`                        | `{ gte: start of day 15, lte: end of day 15 }`                  |
| `?createdAt=greaterThanOrEqual:2026-01-15`     | `{ gte: start of the day }` (`lessThan` also uses the start)    |
| `?createdAt=greaterThan:2026-01-15`            | `{ gt: end of the day }` (`lessThanOrEqual` also uses the end)  |
| `?createdAt=inRange:2026-01-01-2026-01-31`     | `{ gte: start of Jan 1, lte: end of Jan 31 }`                   |
| `?createdAt=inRange:01/01/2026-31/01/2026`     | same range, Brazilian format                                    |
| `?createdAt=in:2026-01-15,2026-01-20`          | `{ in: [Date, Date] }` (`notIn` works the same way)             |

A value that carries a time (`2026-01-15T10:30:00`) is compared as that exact instant, with no day rounding.

> **ℹ️ Type coercion:** query values are automatically cast to the field's type as registered via `@Field()`. If the field is `"number"`, the string `"5"` becomes `5`.

> **⚠️ Invalid values are rejected:** a value that cannot be read as the field's type does not become a filter. `getWhere` answers `400` and does not call the route:
>
> ```json
> { "message": "Filtro inválido.", "errors": [{ "path": "age", "message": "Informe um número válido no filtro \"age\"." }] }
> ```
>
> Number fields accept only a number (optional sign and decimal point): `1,5`, `abc` and `R$ 10` are rejected. Date fields reject what `parseDate` cannot read and days that do not exist (`31/02/2026`). Calling `createWhereConditionQuery` directly throws instead, with the field in `error.path`.

**Programmatic version** (without Express):

```ts
import {buildWhereFromQuery} from "@mateusseiboth/ts-decorators";

// Takes the query object and the MODEL CLASS (it needs static tag + @ModelTagged), not an instance
const where = buildWhereFromQuery(req.query, StreetModel);
```

> **ℹ️** `buildWhereFromQuery` runs the older parser (`createWhereCondition`), which did not change: the operator tables above describe `getWhere` (and `createWhereConditionQuery`, the function behind it). An optional third argument takes the same fixed conditions as the 5th argument of `getWhere`.

---

### `getOrderBy`

Reads `req.query.orderBy` and `req.query.orderMethod`, validates them against the model's fields and populates `res.locals.orderBy`.

> **⚠️ Required dependencies:**
>
> - The model MUST have `@ModelTagged` (to be in the registry)
> - The model MUST have `@InitFields`
> - Only fields with `@Field()` are valid as `orderBy` — invalid values result in `res.locals.orderBy = []` (empty array), not an error

```ts
import {getOrderBy} from "@mateusseiboth/ts-decorators";

// Signature: (req, res, next, ModelClass) — requires a class with static tag
router.get("/", (req, res, next) => getOrderBy(req, res, next, StreetModel), handler);

// GET /streets?orderBy=name&orderMethod=asc
// → res.locals.orderBy = [{ name: "asc" }]

// GET /streets?orderBy=nonExistentField&orderMethod=asc
// → res.locals.orderBy = []  (silent — field has no @Field decorator)
```

> **ℹ️** If either `orderBy` or `orderMethod` is absent from the query, the middleware calls `next()` without setting `res.locals.orderBy`. `makePrismaOptions` treats `undefined` as "no ordering".

---

### Listagem para multi-tenant: `createPaginate`, desempate, busca, fuso, uuid, resumo e GUCs

```ts
import {
  configureDateFilter,
  configureTenantGucs,
  createPaginate,
  executePrismaQuery,
  Field,
  getHandlerContext,
  InitFields,
  makePrismaOptions,
  ModelTagged,
} from "@mateusseiboth/ts-decorators";

// boot: RLS por várias GUCs e o fuso do tenant, lidos do contexto da requisição
configureTenantGucs((ctx) => ({
  "app.conta_id": ctx?.contaId,
  "app.academia_id": ctx?.academiaId,
  "app.rede_id": ctx?.redeId,
  "app.is_super_admin": ctx?.superAdmin === true,
}));
configureDateFilter({ timeZone: () => getHandlerContext()?.academia?.timeZone });

@InitFields
@ModelTagged
class AlunoModel {
  static tag = 10;
  static paginate = { required: true, defaultOffset: 20, maxOffset: 100 };
  static search = { fields: ["nome", "cpf", "telefone"] }; // ?busca=termo
  @Field("uuid") id!: string;
  @Field("uuid") academia_id!: string;
  @Field() nome!: string;
  @Field({ type: "string", normalize: "digits" }) cpf!: string;
}

route.withPrismaOptions(AlunoModel).get("/", listar); // ou withPrismaOptions(Model, { paginate })
const page = await executePrismaQuery(tx.aluno, {
  ...makePrismaOptions(res),
  summary: { sum: ["mensalidade"] }, // data.resumo = { count, sum: { mensalidade } }
});
```

- **`createPaginate({ required, defaultOffset, maxOffset })`:** `required` pagina mesmo sem o
  cabeçalho `paginate` (a lista nunca sai inteira); `offset` acima do `maxOffset` responde 400 em
  `errors[{ path: "offset" }]`. A opção da rota vence o `static paginate` do model.
- **Desempate:** o `getOrderBy` termina a ordem no `id` (ou no `static orderTieBreaker`; `false`
  desliga). Sem desempate, registros com o mesmo valor trocam de página.
- **`@Field("uuid")`:** valor inválido no filtro responde 400 no campo, sem chegar ao banco.
- **Busca:** `static search` no model; cada coluna recebe o termo com o `normalize` dela, e a que
  fica sem termo (texto numa coluna de dígitos) sai do OU.
- **Fuso:** `configureDateFilter` faz o dia do filtro valer no fuso do tenant; sem fuso, o do
  processo.
- **GUCs:** `configureTenantGucs` troca o injetor do `addCompanyIdToTransaction` (`Transactional`,
  `withTransaction`; no `@TransactionalClass`, registre `setTransactionalCompanyFn(addCompanyIdToTransaction)`)
  e o escopo do tenant das chaves de cache (`setTenantScope`), para o total de um tenant não servir
  a outro. `applyTransactionGucs(tx, gucs)` faz o mesmo numa transação aberta à mão. `null` limpa a
  GUC; `undefined` fica de fora.

### `getPaginate`

Reads **HTTP headers** (not query params) and populates `res.locals.paginate`.

> **⚠️ Pagination data comes from request HEADERS, not query params.**

```ts
import {getPaginate} from "@mateusseiboth/ts-decorators";

router.get("/", getPaginate, handler);
```

| Header     | Type   | Default | Description                           |
| ---------- | ------ | ------- | ------------------------------------- |
| `paginate` | string | —       | must be `"true"` to enable pagination |
| `page`     | string | `"1"`   | page number (1-based)                 |
| `offset`   | string | `"10"`  | number of records per page            |

```
Headers: paginate: "true", page: "2", offset: "20"
→ res.locals.paginate = { skip: 20, take: 20, page: 2 }
  // skip = (page - 1) * offset = (2 - 1) * 20 = 20
```

`page` e `offset` aceitam só inteiros a partir de 1 (o que o `parseInt` já lia continua valendo:
`"2abc"` é 2). Zero, negativo ou texto que não é número responde **400** com
`{ message: "Paginação inválida.", errors: [{ path: "page" | "offset", message }] }`, em vez do 500
do Prisma ou de uma página com total negativo.

> **ℹ️** If the `paginate` header is not `"true"`, `res.locals.paginate` stays `undefined` and `makePrismaOptions` omits `skip`/`take` from the Prisma query (returns all records).

---

### `getColumns`

Lê `?fields=id,name` e popula `res.locals.columns` com um `select` do Prisma — o frontend
pede só as colunas que a tela usa, sem criar rota nova para cada projeção.

> **⚠️ Dependências (as mesmas do `getWhere`):**
>
> - O model precisa ter `@ModelTagged` + `@InitFields`
> - Só campos com `@Field()` são projetáveis — o resto é **silenciosamente ignorado** (o model é a whitelist)
> - Para campos aninhados (`?fields=bairro.name`), a relação precisa de `@NestedModel(Model)` ou `@Field(Model)`

```ts
import {getColumns} from "@mateusseiboth/ts-decorators";

// Assinatura: (req, res, next, ModelClass, options?)
router.get("/", (req, res, next) => getColumns(req, res, next, RuaModel), handler);

// GET /ruas?fields=id,name
// → res.locals.columns = { id: true, name: true }

// GET /ruas?fields=name,bairro.name
// → res.locals.columns = { id: true, name: true, bairro: { select: { name: true } } }

// GET /ruas?fields=name,senhaSecreta   (campo sem @Field)
// → res.locals.columns = { id: true, name: true }   (o campo inválido some)

// GET /ruas    (sem ?fields)
// → res.locals.columns fica undefined — a rota devolve o que sempre devolveu
```

| Opção      | Default    | Descrição                                                                   |
| ---------- | ---------- | --------------------------------------------------------------------------- |
| `queryKey` | `"fields"` | Nome do parâmetro de query lido                                              |
| `always`   | `["id"]`   | Campos sempre presentes na projeção (o frontend quase sempre precisa da chave) — passe `[]` para respeitar exatamente a query |

Separadores aceitos: `,` e `;`. Repetição também vale (`?fields=id&fields=name`).

**Como a projeção chega no Prisma:** `makePrismaOptions(res)` repassa `columns` e o
`executePrismaQuery` a aplica — sempre **estreitando** o que a rota já expunha:

| Situação no DAO                      | Resultado com `?fields=`                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| sem `select`/com `include`           | a projeção vira o `select` e o `include` é descartado (Prisma aceita select XOR include) |
| com `select` próprio (whitelist)     | **interseção** — pedir um campo que o DAO não expõe (ex.: hash de senha) não vaza nada |
| interseção vazia                     | a query original é mantida (nada de `select` vazio)                          |

```ts
// UserDAO.get() define select sem o hash de senha:
// GET /api/v1/user?fields=id,name,password
// → select = { id: true, name: true }   ← password simplesmente não existe para a rota
```

> **ℹ️** `getColumns` já faz parte de `RouteBuilder.withPrismaOptions(model)`, junto com
> `getWhere`, `getOrderBy` e `getPaginate` — quem usa o builder ganha `?fields=` sem mexer em rota.

---

### `Idempotent`

Middleware de idempotência para escritas: a MESMA requisição (mesmo header
`x-idempotency-key`, mesmo dono) dentro do TTL devolve a resposta cacheada em vez
de executar de novo — inclusive quando duas chegam AO MESMO TEMPO (a segunda
aguarda a primeira e recebe a mesma resposta).

```ts
import {Idempotent} from "@mateusseiboth/ts-decorators";

const idempotent = Idempotent({ttl: 30_000}); // default 60s

router.post("/entrada", idempotent, handler);
```

| Opção      | Default                                   | Descrição                                                        |
| ---------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `ttl`      | `60_000` ms                               | Janela em que a chave vale (replays devolvem a resposta cacheada) |
| `identify` | contexto (user+entidade) → `Authorization`+entidade | Deriva o "dono": chave criada por um dono só reproduz para ele |

- O cliente envia o header **`x-idempotency-key`** (sem ele → `400`).
- Uma chave usada por outro dono → `409` (não vaza resposta entre usuários/entidades).
- No frontend, gere uma chave por operação e renove-a depois de cada escrita concluída.

---

## DI — `@Injectable` + `container`

Container de injeção de dependências por construtor. `@Injectable()` captura os
tipos dos parâmetros (via `reflect-metadata`) e `container.get()` resolve a árvore
inteira, cacheando por escopo (`@Singleton` default, `@Scoped`, `@Transient` — ver
[Lifecycle](#lifecycle--di--singleton--scoped--transient)).

> **Regra de ouro:** `@Injectable()` é sempre o decorator MAIS PRÓXIMO da classe
> (por último na pilha) — ele precisa ler os tipos do construtor original.

```ts
import {container, Injectable} from "@mateusseiboth/ts-decorators";

@Injectable()
class CategoriaDAO { ... }

@Transaction()          // decorators de classe acima...
@Injectable()           // ...@Injectable SEMPRE por último (mais perto da classe)
class CategoriaService {
  constructor(private readonly dao: CategoriaDAO) {}   // resolvido pelo container
}

@Injectable()
class CategoriaController {
  constructor(protected readonly service: CategoriaService) {}
}

const controller = container.get(CategoriaController); // resolve DAO → Service → Controller
```

API do `container`:

| Método                           | Descrição                                                                  |
| -------------------------------- | -------------------------------------------------------------------------- |
| `get(Classe)`                    | Resolve (e cacheia por escopo). Também ATIVA `@Listen`, `@Cron` e `@Processor` da instância |
| `register(Classe, instancia)`    | Override: injeta uma instância pronta (testes, adapters, mocks)            |
| `setScopeResolver(() => chave)`  | Chave do escopo para `@Scoped` (ex.: requestId do contexto)                |
| `clearScope(chave)` / `clear()`  | Limpeza (fim de request / testes)                                          |

> **ℹ️** `container.get()` de uma classe com `@Processor` já inicia o consumo da
> fila — registre seus jobs no boot com um simples `container.get(MeuJob)`.

---

## Decorators

### `@Field` / `@InitFields`

The foundation of the entire metadata system. Every other feature that needs to know your model's field names or types depends on these two decorators.

> **⚠️ `@InitFields` MUST be applied to every model class. `@Field()` MUST decorate every property that should be visible to `getWhere`, `getOrderBy`, `@AutoConvert`, and `collectFieldTypes`. Fields without `@Field()` are completely invisible to the system.**

> **📖 Full type reference:** [`doc/field-types.md`](doc/field-types.md) — every type `@Field` accepts (primitives, all `Temporal` types, nested models), what each one converts from, and the time zone rules.

```ts
import {Field, InitFields} from "@mateusseiboth/ts-decorators";

@InitFields // REQUIRED — initialises the field registry for this class
class DistrictModel {
  @Field() id!: string; // type inferred from reflect-metadata (legacy only)
  @Field() name!: string;
  @Field("number") code!: number; // type explicit — required when using TC39 decorators
  @Field() active!: boolean;
  @Field() createdAt!: Date;
  @Field(Temporal.ZonedDateTime) startsAt!: Temporal.ZonedDateTime; // Temporal types are field types, not nested models

  // ❌ this field does NOT exist for getWhere/getOrderBy/@AutoConvert:
  internalNotes!: string;
}
```

**Legacy vs TC39 type inference:**

| Mode                                      | `@Field()`                                               | `@Field("number")`         |
| ----------------------------------------- | -------------------------------------------------------- | -------------------------- |
| Legacy (`emitDecoratorMetadata: true`)    | Type is auto-inferred via `reflect-metadata`             | Works (explicit overrides) |
| TC39 Stage 3 (no `emitDecoratorMetadata`) | Type defaults to `"any"` — **always pass it explicitly** | Required                   |

**`getFieldTypes(instance)`** — returns all registered fields as `Record<fieldName, typeName>`:

```ts
import {getFieldTypes} from "@mateusseiboth/ts-decorators";

getFieldTypes(new DistrictModel());
// → { id: "string", name: "string", code: "number", active: "boolean", createdAt: "date" }
// ⚠️ "internalNotes" is NOT here — it has no @Field()
```

**`getFieldTypeByKey(instance, key)`** — returns the type of a single field, or `undefined` if not decorated:

```ts
import {getFieldTypeByKey} from "@mateusseiboth/ts-decorators";

getFieldTypeByKey(new DistrictModel(), "code"); // → "number"
getFieldTypeByKey(new DistrictModel(), "internalNotes"); // → undefined
```

> **ℹ️ Inheritance:** `getFieldTypes` walks the prototype chain, so a subclass automatically inherits the `@Field()` registrations of its parent class.

---

#### Campo cifrado e normalização: `@Field({ encrypted, normalize })`

No lugar do tipo, o `@Field` aceita opções. As duas valem no caminho único de gravação e leitura
(`encodeRowForCollection`, `decodeRowsForCollection`/`readRows`, `executeOrmQuery`,
`executePrismaQuery`, `updateById`), no Prisma 7 (delegate) e no 8 (coleção). Com as duas no mesmo
campo, normaliza antes de cifrar.

```ts
import {configureEncryption, Field, InitFields} from "@mateusseiboth/ts-decorators";

// boot: a chave atual grava; as outras só leem
configureEncryption({
  keys: {k1: process.env.FIELD_KEY_K1, k2: process.env.FIELD_KEY_K2},
  current: "k2",
});

@InitFields
class CertificadoModel {
  static prismaModel = "Certificado"; // opcional: o default é o nome da classe sem "Model"
  @Field({type: "string", encrypted: true}) senha!: string;
  @Field({type: "string", normalize: "digits"}) cnpj!: string; // "digits" | "trim" | "upper" | função | lista
}
```

- **Cifra:** AES-256-GCM (`node:crypto`, síncrono), IV aleatório por valor, texto
  `enc:v1:<impressão digital da chave>:<iv>:<dado>` (base64url). A impressão digital é o SHA-256
  da chave, não o rótulo: chave errada no ambiente dá "chave não configurada" e o dado fica intacto.
- **Classe que não casa com o model:** `EncryptionError` `UNMAPPED_MODEL` no primeiro uso
  (Prisma 8, pelo contrato; Prisma 7, pelo client registrado). No Prisma 7, chame também
  `checkEncryptedModels(Object.values(Prisma.ModelName))` no boot.
- **Sem `configureEncryption`:** erro no primeiro uso. Chave fora de 32 bytes: erro no boot.
  Gere com `openssl rand -base64 32`.
- **Legado:** valor em texto puro é lido como está e a próxima gravação cifra. `reencryptColumn`
  recifra uma coluna em lote e relata quantos valores ficaram em cada chave
  (`countByEncryptionKey`, `listEncryptionKeys`, `keyFingerprint`).
- **Perder a chave é perder o dado.** O backup do banco não contém a chave: guarde-a num cofre.
- **Consequências:** campo cifrado não serve para filtro (o `getWhere` responde 400), ordenação
  (o `getOrderBy` ignora) nem índice; a coluna precisa ser `TEXT`; o valor é mascarado no
  `applyMask` e no `AuditLogger` mesmo sem `@MaskSensitive`.
- **`normalize`:** vale também no filtro do `getWhere` (CPF com máscara acha o CPF gravado sem
  ela). Nulo e vazio passam intactos. `normalizeValue` é exportado.

---

### `@ModelTagged` / `@DAOFor`

A global runtime registry that maps numeric tags to Model and DAO classes.

> **⚠️ Required dependencies:**
>
> - The class MUST have `@InitFields` applied **before** `@ModelTagged` in the decorator list (decorators are applied bottom-up, so `@InitFields` should appear below `@ModelTagged`)
> - The class MUST have a `static tag` property
> - Duplicate tags cause `process.exit(1)` at startup — tags must be unique across the entire application
> - `@DAOFor(tag)` throws if the corresponding model tag has not been registered yet

```ts
import {ModelTagged, DAOFor, getModel, getDAO, getAllModels} from "@mateusseiboth/ts-decorators";

// Decorator order matters: @ModelTagged runs first (bottom-up), @InitFields runs second
@ModelTagged // ← 2nd to run
@InitFields // ← 1st to run
class DistrictModel {
  static tag = 7770;

  @Field() id!: string;
  @Field() name!: string;
}

@DAOFor(DistrictModel.tag) // links DAO.model = DistrictModel
class DistrictDAO {
  // DistrictDAO.model === DistrictModel
}

getModel(7770); // → DistrictModel
getDAO(7770); // → DistrictDAO
getAllModels(); // → [DistrictModel, ...]
getAllDAOs(); // → [DistrictDAO, ...]
```

---

### `@NestedModel`

Registers a field as a relation to another Model, enabling dot-notation nested filters in `getWhere` (e.g. `?district.name=Downtown`) and recursive field traversal in `collectFieldTypes`.

> **⚠️ Required dependencies:**
>
> - The field MUST also have `@Field()` — `@NestedModel` alone does not register the field in the type system
> - The related model MUST have `@InitFields` + `@Field()` on its fields, otherwise nested filters and `collectFieldTypes` will return nothing for that relation
> - The related model MUST have `@ModelTagged` if you intend to use `getWhere`/`getOrderBy` on it directly

```ts
import {Field, InitFields, ModelTagged, NestedModel} from "@mateusseiboth/ts-decorators";

@ModelTagged
@InitFields
class StreetModel {
  static tag = 8880;

  @Field() id!: string;
  @Field() name!: string;

  // Both @Field and @NestedModel are required:
  @Field() // registers "district" as a known field
  @NestedModel(DistrictModel) // tells the system it's a nested model
  district?: DistrictModel;

  // ❌ only @NestedModel without @Field — district2 won't appear in getWhere at all:
  @NestedModel(DistrictModel)
  district2?: DistrictModel;
}
```

With this setup, `?district.name=Downtown` in `getWhere` correctly produces `{ district: { name: "Downtown" } }`.

---

### `@AutoConvert`

Automatically coerces values in the first argument (`data`) of a method to the types declared with `@Field()` on the current instance's class.

> **⚠️ Required dependencies:**
>
> - The class (or a parent in its prototype chain) MUST have `@InitFields` and `@Field()` decorators
> - `@AutoConvert` reads the field types from `this` at runtime — the method must be called on an instance that has the metadata
> - Keys in `data` that do not have a corresponding `@Field()` are left untouched
> - `null` / `undefined` values are always passed through as `null` (no conversion attempted)

```ts
import {AutoConvert, Field, InitFields} from "@mateusseiboth/ts-decorators";

@InitFields
class ProductModel {
  @Field() name!: string;
  @Field("number") price!: number;
  @Field() active!: boolean;
  @Field() createdAt!: Date;
}

class ProductController {
  model = new ProductModel();

  @AutoConvert
  async create(data: Record<string, any>) {
    // Before: data = { name: "Bolt", price: "9.99", active: "true", createdAt: "2026-01-01" }
    // After:  data = { name: "Bolt", price: 9.99,   active: true,   createdAt: Date(...) }
  }
}
```

**Conversion rules:**

| Field type  | Input                 | Output         |
| ----------- | --------------------- | -------------- |
| `"number"`  | `"9.99"`              | `9.99`         |
| `"number"`  | `"abc"`               | `null` (NaN)   |
| `"bigint"`  | `"123"`               | `123n`         |
| `"bigint"`  | `"abc"`               | `null`         |
| `"boolean"` | `"false"/"0"/"N"`/`0` | `false`        |
| `"boolean"` | `"true"/"1"/"S"`/`1`  | `true`         |
| `"boolean"` | anything else         | `Boolean(val)` |
| `"date"`    | `"2026-01-01"`        | `Date(...)`    |
| `"date"`    | `0` or `"0"`          | `null`         |
| `"date"`    | invalid string        | `null`         |
| `"string"`  | `42`                  | `"42"`         |

**Temporal types** — every `Temporal` type is accepted as a field type, alongside `"date"`:

| Field type                                | Input                                          | Output                                          |
| ----------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `"zoneddatetime"` / `"zoned"`             | `"2026-01-15T10:00:00-03:00[America/Sao_Paulo]"` | `Temporal.ZonedDateTime` — **time zone kept**   |
| `"zoneddatetime"`                         | `"2026-01-15T10:00:00-03:00"`                  | `ZonedDateTime` with time zone `-03:00`         |
| `"zoneddatetime"`                         | `"2026-01-15T13:00:00Z"`                       | `ZonedDateTime` in `UTC`                        |
| `"instant"`                               | `"2026-01-15T13:00:00Z"`, epoch, `Date`        | `Temporal.Instant`                              |
| `"plaindate"`                             | `"15/01/2026"`, `"2026-01-15"`, `Date`         | `Temporal.PlainDate`                            |
| `"plaindatetime"` / `"datetime"`          | `"2026-01-15T10:30:00"`                        | `Temporal.PlainDateTime`                        |
| `"plaintime"` / `"time"`                  | `"10:30"`                                      | `Temporal.PlainTime`                            |
| `"plainyearmonth"` / `"yearmonth"`        | `"2026-01"`, `"2026-01-15"`                    | `Temporal.PlainYearMonth`                       |
| `"plainmonthday"` / `"monthday"`          | `"--01-15"`, `"15/01/2026"`                    | `Temporal.PlainMonthDay`                        |
| `"duration"`                              | `"PT1H30M"`, `{hours: 1}`, `5400000` (ms)      | `Temporal.Duration`                             |
| any of them                               | value no strategy can read                     | `null`                                          |

Each type accepts every date format `parseDate` understands (BR `DD/MM/YYYY`, ISO, RFC, epoch in seconds or milliseconds, `Date`, other `Temporal` values, property bags) plus the `Temporal.X.from` native format. The type name may also be written fully qualified (`"Temporal.ZonedDateTime"`) or passed as the constructor itself:

```ts
@InitFields
class ScheduleModel {
  @Field(Temporal.ZonedDateTime) startsAt!: Temporal.ZonedDateTime; // constructor — NOT a nested model
  @Field("instant") recordedAt!: Temporal.Instant;
  @Field("plaindate") competence!: Temporal.PlainDate;
  @Field("duration") duration!: Temporal.Duration;
}
```

> **ℹ️ Time zone:** `ZonedDateTime` preserves whatever the payload carried — the IANA annotation, the raw offset, or `UTC` for `Z`. Values with no zone at all (BR strings, `Date`, epoch, ISO without offset) fall back to the system time zone (`Temporal.Now.timeZoneId()`). `JSON.stringify` keeps the full string, `[America/Sao_Paulo]` included.

> **ℹ️ `parseDate` and `getWhere`:** `"date"` fields also accept `Temporal` values as input, and `getWhere` treats `instant` / `zoneddatetime` / `plaindate` / `plaindatetime` fields as dates (same day range filter as `"date"`).

> **ℹ️ `parseDate` rules:** a date-only ISO string (`"2026-01-15"`) is midnight of that day **in the time zone of the process**, the same reading as `"15/01/2026"` and the Temporal converters (it is not read as UTC, so the day never shifts in a negative offset). ISO with a time and `Z`/offset stays the exact instant. A date that does not exist (`"2026-02-31"`, `"31/02/2026"`) returns `null`. `parseDate` never throws: booleans, `Symbol` and the Temporal types that carry no date (`Duration`, `PlainYearMonth`, `PlainMonthDay`) return `null`.

**Nested models** (`@Field(Model)` / `@Field([Model])`) are instantiated and converted recursively. The value shape is normalised regardless of how the field was declared:

| Declared as        | Input value  | Output                          |
| ------------------ | ------------ | ------------------------------- |
| `@Field(Model)`    | object       | `Model` instance                |
| `@Field(Model)`    | **array**    | array of `Model` instances      |
| `@Field([Model])`  | array        | array of `Model` instances      |
| `@Field([Model])`  | object       | array with one `Model` instance |
| either             | `null`       | `null`                          |

> **⚠️** Arrays are always converted item by item, even on a to-one `@Field(Model)`. Without this, an array payload would be fed to a single instance's `setData` — no keys match and the result silently keeps only the superclass defaults.

---

### `@Cacheable` / `@CacheMethod` / `@Cached` / `CacheProvider`

In-memory cache with per-entity isolation and automatic invalidation on write methods. No external dependencies.

```ts
import { Cacheable, CacheMethod, Cached, CacheProvider, clearAllCache, getCacheStats } from "@mateusseiboth/ts-decorators";

@Cacheable({
  ttl: 30_000,                                     // time-to-live in ms
  cacheable: ["get", "list"],                      // functions whose responses are cached
  invalidate: ["create", "update", "deleteById"],  // functions that invalidate the cache
})
class DistrictController {
  async get(req, res) { /* sets X-Cache: HIT or MISS */ }
  async create(req, res) { /* invalidates all cache entries for this entity — only on success */ }

  @CacheMethod({ ttl: 60_000 })  // per-method TTL override
  async findSpecial(req, res) { ... }
}
```

> The legacy option names `readMethods` / `writeMethods` are still accepted as aliases for `cacheable` / `invalidate`.

> **ℹ️ Inherited methods:** `@Cacheable`, `@Auditable` and `@TransactionalClass` also wrap the methods the class **inherits** from a base class (`get`, `create`, `update`, `deleteById` living in a base controller). The wrapper is placed on the prototype of the decorated class, so the base class and its other subclasses are untouched. If the base class carries the same decorator, the inherited method arrives already wrapped and is not wrapped again.
>
> ```ts
> class BaseController {
>   async get(req, res) { ... }
>   async create(req, res) { ... }
> }
>
> @Cacheable({ cacheable: ["get"], invalidate: ["create"] })
> class DistrictController extends BaseController {} // get/create are cached/invalidated here only
> ```

**Cache key** is built from: HTTP method, `baseUrl`, path, route params, query string, pagination headers, and `res.locals.where`/`orderBy`/`paginate`.

**Entity isolation (RLS):** cache entries are partitioned by `className → entity`. The entity is resolved from `res.locals.entity` or, when absent, from the injected handler context (`getHandlerContext().entity`). Writing to one entity never invalidates another.

**Invalidation on success only:** functions listed in `invalidate` run inside `try/finally` and only clear the cache when they complete successfully. If the function throws, the cache is preserved.

**Limits:** `maxEntries: 200` per entity — oldest entries are evicted when exceeded.

#### `@Cached` — caching return values (reports & their filters)

For functions that **return data directly** (report queries, expensive filters) instead of writing to `res.json`. The entity comes from the context (RLS) — it is never passed as an argument, so no extra `SELECT` is needed to scope the data.

```ts
class BoletimController {
  @Cached({ tag: "boletim-imovel", ttl: 60_000 })
  async gerarBoletim(filtros) {
    return this.dao.query(filtros); // cached by return value
  }
}
```

The generated key follows the pattern `report-<Class>-<function>-<tag>|ent:<entity>|args:<...>`, which lets you build a dependency tree and invalidate a report manually when an unrelated mutation changes what it reads:

```ts
CacheProvider.invalidate("report-BoletimController-gerarBoletim-*");
```

#### `CacheProvider` — manual control

```ts
CacheProvider.add(key, value, ttlMs?);   // add/update a key manually
CacheProvider.get(key);                  // read (respects expiration)
CacheProvider.has(key);                  // check
CacheProvider.keys(prefix?);             // list keys (to build the tree)
CacheProvider.invalidate();              // no arg → clears ALL cache (HTTP + flat)
CacheProvider.invalidate(key);           // exact key
CacheProvider.invalidate("prefix-*");    // prefix match (report tree)
```

**Testing helpers:**

```ts
clearAllCache(); // wipes everything
getCacheStats(); // → { DistrictController: 12, StreetController: 5 }
```

---

### `@RateLimit` / `@RateLimitMethod`

In-memory fixed window rate limiter: the counter of each key starts at its first request and is reset when `windowMs` has elapsed. No Redis required.

```ts
import { RateLimit, RateLimitMethod, rateLimitMiddleware, clearRateLimitStore } from "@mateusseiboth/ts-decorators";

// Applied to an entire controller (only the methods declared on the class itself, not inherited ones)
@RateLimit({ maxRequests: 100, windowMs: 60_000 })
class MyController { ... }

// Applied to a single method
class MyController {
  @RateLimitMethod({ maxRequests: 10, windowMs: 60_000 })
  async create(req, res) { ... }
}

// As a plain Express middleware
router.use(rateLimitMiddleware({ maxRequests: 100, windowMs: 60_000 }));
```

Returns **HTTP 429** when the limit is exceeded, with the following response headers:

| Header                  | Description                              |
| ----------------------- | ---------------------------------------- |
| `X-RateLimit-Limit`     | Maximum requests allowed in the window   |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset`     | Unix timestamp when the window resets    |
| `Retry-After`           | Seconds until the client may retry       |

The default rate-limit key is `IP:entity`. Provide a custom `keyGenerator` function to change this:

```ts
@RateLimit({
  maxRequests: 50,
  windowMs: 60_000,
  keyGenerator: (req, res) => `${req.ip}:${res.locals.userId}`,
})
class MyController { ... }
```

**Testing helper:**

```ts
clearRateLimitStore(); // resets all counters
```

---

### `@Auditable`

Automatically records an audit trail for `create`, `update`, and `deleteById` calls, writing to an `audit_log` table after each successful operation. The write is **fire-and-forget** (does not block the response).

```ts
import { Auditable, setAuditStorage } from "@mateusseiboth/ts-decorators";

@Auditable
class OrderController {
  async create(req, res) { ... }
  async update(req, res) { ... }
  async deleteById(req, res) { ... }
}
```

**`before` is captured by default.** On `UPDATE`/`DELETE` the decorator reads the previous row (one extra `findUnique` per write) and stores it in `before`. Turn it off when the request body already tells the story and `after` is enough, to save that query:

```ts
@Auditable({ captureBefore: false })
class OrderController { ... }
```

| Option            | Default | Effect                                                                   |
| ----------------- | ------- | ------------------------------------------------------------------------ |
| `captureBefore`   | `true`  | `findUnique` for the previous row on `UPDATE`/`DELETE` (one extra query) |
| `captureResponse` | `true`  | Intercepts `res.json` to use the response as `after` and read a new `id` |

The methods are audited even when they are inherited from a base controller (see the note in [`@Cacheable`](#cacheable--cachemethod--cached--cacheprovider)); when the base class is `@Auditable` too, each write is still audited once.

Each audit entry contains:

| Field       | Source                                                    |
| ----------- | --------------------------------------------------------- |
| `action`    | `"CREATE"` / `"UPDATE"` / `"DELETE"`                      |
| `entity`    | Class name without `"Controller"`                         |
| `entityId`  | `req.params.id` → `this.data.id` → `id` of the `res.json` payload |
| `userId`    | From `res.locals.userInfo.id`                             |
| `entidade`  | From `res.locals.entity`                                  |
| `before`    | `prismaModel.findUnique` on `UPDATE`/`DELETE`; `null` on `CREATE` or with `captureBefore: false` |
| `after`     | `res.json` payload → `this.data` → `req.body`             |
| `timestamp` | `new Date()` at time of write                             |
| `method`    | `"ClassName.methodName"`                                  |
| `ip`        | `req.ip`                                                  |

Override the default storage adapter (e.g. for tests or a different persistence layer):

```ts
setAuditStorage(async (entry, tx) => {
  await myCustomLogger.write(entry);
});
```

---

### `@logDecorator`

Adds a `this.log(message)` method to the class prototype. It writes through the package `logger` at `info` level, prefixed with a timestamp and the class name. Nothing else changes: the methods of the class are not wrapped and `console.log` is not touched.

```ts
import {logDecorator} from "@mateusseiboth/ts-decorators";

@logDecorator
class MyController {
  declare log: (message: string) => void; // injected by the decorator

  async get(req, res) {
    this.log("fetching records...");
    // → "[12/04/2026, 14:32:01 - MyController] fetching records..."
  }
}
```

The timestamp uses the `pt-BR` locale in the `America/Campo_Grande` time zone. Since the output goes through `logger.info`, it is silenced by `setLogLevel("warn")` or lower (see [Log levels](#log-levels)).

---

### Prisma 8 (`@prisma/orm-postgres`)

O pacote roda tanto sobre o client do Prisma 7 quanto sobre a fachada do Prisma 8, e detecta
qual está em uso pela forma da transação: a do 7 tem `$executeRawUnsafe`; a do 8 tem
`execute`/`query`/`orm`. Nenhum dos dois é importado pelo pacote. Quem usa o 8 registra a
fachada e os combinadores de predicado uma vez, no bootstrap:

```ts
// src/index.ts (bootstrap)
import { and, not, or } from "@prisma/orm-postgres/orm-client";
import { ProjectionItem, SubqueryExpr } from "@prisma/orm-postgres/relational-core/ast";
import {
  configurePrisma8,
  setCompanyIdInjector,
  setHandlerContext,
  setPrismaClient,
} from "@mateusseiboth/ts-decorators";
import { db } from "@database/db"; // postgres<Contract>({ contractJson, url })
import { getContext, requireContext } from "@middlewares/context";

configurePrisma8(
  {
    db,
    and,
    or,
    not,
    // opcionais:
    ast: { SubqueryExpr, ProjectionItem },          // ?orderBy=relacao.campo (to-one)
    enums: { situacao: { ATIVO: "A", INATIVO: "I" } }, // rótulo do enum <-> valor no banco
    numericAsNumber: true,                          // numeric volta como number
  },
  { base: true }, // a configuração de referência: resetPrisma8() volta para ela nos testes
);
setPrismaClient(db); // Transactional/withTransaction passam a abrir db.transaction
setHandlerContext(getContext, requireContext);

// Tenant (RLS): o padrão já serve o Prisma 8, nada a fazer. Só troque se a convenção for outra:
// setCompanyIdInjector(async (tx, id) => tx.execute(rawParamStatementPlan`SELECT set_config('app.tenant', ${String(id)}, true)`));
```

Com isso, `addCompanyIdToTransaction(tx, id)`, os `SAVEPOINT`s do `@TransactionalClass` e o
`before` do `@Auditable` funcionam com a transação do 8 sem mudança no chamador. O tenant padrão
vai como `SELECT set_config('my.company_id', $1, true)` com o id como VALOR interpolado no plano
(`db.raw.sql`), nunca colado no texto: UUID e id numérico servem igual (veja
[Company id injection](#company-id-injection-multi-tenant--rls)).

| Export | Descrição |
| ------ | --------- |
| `configurePrisma8(config, { base? })` | Registra `db`, `and`, `or`, `not` e os opcionais `ast`, `enums`, `numericAsNumber` |
| `resetPrisma8()` / `clearPrisma8()` | Volta para a configuração `base` (use no `afterEach`) / esquece tudo |
| `getPrisma8()`, `getEnumLabels()`, `isNumericAsNumber()` | Leitura da configuração |
| `isPrisma7Tx(tx)` / `isPrisma8Tx(tx)` | Detecção pela forma da transação |
| `ormCollection(tx, "Bairro")` | A coleção do model na transação do 8 (`tx.orm.public.Bairro`) |
| `runStatement(tx, sql)` | Statement SEM parâmetros (`SAVEPOINT`), no 7 ou no 8 |
| `rawStatementPlan(sql)` / `rawRowsPlan(sql, spec)` | Planos crus sem parâmetros (sem linhas / com linhas e codec por coluna) |
| `rawParamStatementPlan\`...${valor}\`` | Plano cru sem linhas COM parâmetros: cada valor interpolado vai como `$n` |

**Ordenar por relação (`ast`, 2.0.0-rc.14 da base).** `?orderBy=contribuinte.name` ordena pela
coluna da relação to-one, em quantos níveis o model declarar: a coluna vira uma subconsulta
correlacionada no `ORDER BY`. Sem `ast` no `configurePrisma8`, ordenar por relação lança.

**Enums (`enums`).** O ORM do 8 lê e grava o VALOR do enum (`"03"`) e o contrato descarta o
rótulo (`ISENTO`). Com o mapa registrado, rótulo vira valor na escrita e no filtro, e valor vira
rótulo na leitura: o mesmo contrato do Prisma 7.

**`numeric` como `number` (`numericAsNumber`).** O Prisma 8 decodifica `numeric`
como STRING decimal (`"412.6600"`) e não há codec que devolva número. Quem guarda dinheiro e
quantidade em `numeric` liga a opção, e a leitura devolve `number` em toda a árvore (linha,
listas e relações de `include`), tanto em `readRows`/`decodeRowsForCollection` quanto em
`executeOrmQuery`. Na escrita e no filtro, `encodeForCodec` troca o `number` pelo texto numérico
canônico que o codec exige (`412.66` → `"412.66"`, `1e-7` → `"0.0000001"`), e a coluna arredonda
na escala dela. É opt-in: sem a opção, a leitura segue devolvendo o texto. SQL cru não passa por
aqui: declare o codec da coluna do resultado (`::float8` no SELECT).

**Datas e codecs (`Temporal`).** O Prisma 8 devolve `Temporal` nas colunas de data. As leituras do
pacote (`readRows`, `executeOrmQuery`) e o `convertBigIntValues` serializam no mesmo ISO com `Z`
que o `Date.toISOString()` dava no 7. `encodeForCodec`/`decodeForCodec` convertem por codec
(`pg/timestamptz-temporal@1`, `pg/int8@1` vira `bigint`...), `encodeRowForCollection` e
`decodeRowsForCollection` aplicam o codec de cada campo da coleção, e `temporalToIso`,
`temporalToDate`, `datesFromTemporal` e `isTemporal` ajudam quem ainda faz conta com `Date`. O
codec é lido em `field.codec` (até a rc.17 do Prisma 8) e em `field.returnType.codec` (rc.18 em
diante).

#### `executeOrmQuery(collection, options)`

O irmão do `executePrismaQuery` para uma coleção do Prisma 8 (`tx.orm.public.Bairro`). Recebe as
MESMAS opções que `makePrismaOptions` monta a partir de `getWhere`/`getOrderBy`/`getPaginate`/
`getColumns` (`where`, `orderBy`, `skip`, `take`, `page`, `select`, `include`, `distinct`,
`columns`, `deriveTotal`, `countTtlMs`) e devolve a MESMA resposta `{ data: { data, paginacao } }`.
Sem paginação, faz uma consulta só.

```ts
const bairros = tx.orm.public.Bairro;
return executeOrmQuery(bairros, makePrismaOptions(res));
```

Peças que ela usa: `countRows(collection)` conta as linhas da coleção já filtrada (pelo
`aggregate`, já que `count()` não existe no topo), `readRows(collection, rows)` entrega as linhas
lidas no shape do Prisma 7 (enum pelo rótulo, `bigint`/`Temporal` serializados) e
`collectionMeta(collection)` expõe `contract`, `modelName` e `namespaceId` da coleção.

#### Tradutores: `applyWhere`, `applyOrderBy`, `applyProjection`, `applyQueryOptions`

O `where` do Prisma 7 (`{ name: { contains: "x", mode: "insensitive" }, setor: { name: "Sul" } }`)
vira o predicado do 8 (`(b) => and(b.name.ilike("%x%"), b.setor.some((s) => s.name.eq("Sul")))`).
Cobre `equals`/`not`/`in`/`notIn`/`gt`/`gte`/`lt`/`lte`/`contains`/`startsWith`/`endsWith`
(+`mode`), `AND`/`OR`/`NOT` e relações (`some`/`every`/`none`/`is`/`isNot`; objeto plano é `some`).
O termo de `contains` é escapado (`%`, `_`, `\`), como o 7 sempre tratou; `contains` em coluna
sem busca por texto (uuid) vira igualdade. `{ equals, mode: "insensitive" }` vira `ilike` do termo
inteiro, escapado; `escapeLike(termo)` é exportado para quem monta o `ilike` nativo. O que não tem equivalente (`search`, filtro em JSON,
`_count`) falha ALTO em vez de silenciar. `applyOrderBy` aceita objeto, lista e a forma
`{ sort, nulls }`, e ordena coluna `Boolean` (o codec do 8 nasce sem `order`). `buildPredicate` devolve só o predicado; `orderByLambdas` só as lambdas de
ordenação; `applyProjection` aplica `select`/`include`/`distinct` (`isRelationField` diz se o
campo é relação).

```ts
const linhas = await applyQueryOptions(tx.orm.public.Bairro, {
  where: buildWhereFromQuery(filtros, BairroModel),
  orderBy: { sequencial: "asc" },
  include: { rua: true },
  take: 50,
}).all();
```

#### Fakes para teste sem banco: `@mateusseiboth/ts-decorators/testing`

`FakeCollection`, `fakeProxy`, `fakeTx8`, `fakeDb8`, `fakeCombinators` e `fakeAst` imitam a
superfície do Prisma 8 e devolvem árvores serializáveis (`{ op: "ilike", field: "name", value:
"%x%" }`), para testar DAO e tradução de filtro com `toEqual`, sem Postgres. A `FakeCollection`
registra as leituras (`calls`) e as escritas (`writes`: `create`, `createAll`, `upsert`,
`update`, `updateAndCount`, `delete`, `deleteAndCount`), tem `groupBy`, `aggregate` (`count` de
`count`; `sum`/`avg`/`min`/`max` de `agregados`, pelo nome do resultado) e `with(fragmento)`, e
devolve o que você passar em `FakeResults`. A `fakeTx8` guarda o SQL de cada plano cru em `statements` e o
plano inteiro (com os valores parametrizados) em `plans`.

```ts
import { configurePrisma8, resetPrisma8 } from "@mateusseiboth/ts-decorators";
import {
  FakeCollection,
  fakeCombinators,
  fakeDb8,
  fakeTx8,
  setFakeWriteHook,
  type FakeContractModels,
} from "@mateusseiboth/ts-decorators/testing";

const models: FakeContractModels = { Bairro: { fields: ["id", "nome"] } };

beforeEach(() => configurePrisma8({ db: fakeDb8(), ...fakeCombinators }));
afterEach(() => {
  resetPrisma8();
  setFakeWriteHook(); // remove o gancho
});

test("cria o bairro", async () => {
  const bairros = new FakeCollection(models, "Bairro", { rows: [] });
  const tx = fakeTx8(models, { Bairro: bairros });
  await new BairroDAO(tx).create({ nome: "Centro" });
  expect(bairros.writes.map((w) => w.data)).toEqual([{ nome: "Centro" }]);
});
```

`setFakeWriteHook(fn)` aplica uma função a cada linha gravada no fake, para o teste reproduzir o
que o middleware do projeto acrescenta na escrita real (auditoria, tenant, datas).

---

#### Trechos de SQL cru: `sql`, `joinSql`, `EMPTY_SQL`, `toTemplate`

O `Prisma.sql`, o `Prisma.join` e o `Prisma.empty` do Prisma 7, para o `db.raw.sql` do 8. O
`db.raw.sql` só interpola VALOR; para montar um comando em pedaços (filtro opcional, lista de
condições) o trecho interpolado vira texto do comando e os valores dele, parâmetros na mesma ordem.

```ts
import {EMPTY_SQL, joinSql, sql, toTemplate} from "@mateusseiboth/ts-decorators";

const nomes = joinSql([sql`nome = ${"Natal"}`, sql`nome = ${"Páscoa"}`], " OR ");
const filtro = sql`tenant_id = ${10} AND (${nomes})${somenteAtivos ? sql` AND ativo` : EMPTY_SQL}`;
const plano = db.raw.sql(...toTemplate(sql`SELECT id FROM feriados WHERE ${filtro}`))
  .returnsRow({id: "pg/text@1"})
  .build();
```

O texto do trecho nunca vem da requisição: valor de fora entra sempre como `${valor}`. Data
interpolada vai como `timestamptz` quando o `configurePrisma8` recebe o `param` de
`@prisma/orm-family-sql/relational-core`; sem ele, data no SQL cru lança.

#### Filtro conferido pelo contrato: `assertWhereFitsContract`

`assertWhereFitsContract(colecao, where)` lança `InvalidFilterError` (`statusCode` 400) no nulo em
coluna obrigatória (`?nome=isNull:x`), que o Prisma 7 recusava antes de ir ao banco e o Prisma 8
executaria devolvendo a página vazia. O contrato vem da própria coleção; chave que não é coluna do
model fica para o ORM. Nos fakes, `required` no `FakeModelMeta` declara as colunas NOT NULL.

```ts
assertWhereFitsContract(tx.orm.public.Bairro, res.locals.where);
return executeOrmQuery(tx.orm.public.Bairro, makePrismaOptions(res));
```

#### Leituras preparadas e compartilhadas: `prepareRead`, `shareReads`, `readShared`

- `prepareRead(() => db.prepare(...))`: a leitura de forma fixa e muito chamada é compilada uma vez
  por processo e executada na transação de cada chamada (a RLS vale igual). Preparação que falha
  não fica guardada.
- `shareReads(tx, fn)` / `readShared(tx, chave, ler)`: dentro de `shareReads`, a leitura de mesma
  chave vai ao banco uma vez. Fora dele nada é guardado.

#### Statements crus: `runStatement`, `rawStatementPlan`, `rawRowsPlan`

`runStatement(tx, sql)` executa um statement SEM parâmetros na transação, do 7 ou do 8
(`SAVEPOINT`). Para o 8, `rawRowsPlan(sql, { coluna: "pg/text@1" })` monta um plano que devolve
linhas (`tx.query(plano)`); cada coluna declara o codec que a decodifica.

### Trava otimista: `updateById`

Dois operadores editam o mesmo registro: sem trava, o último a salvar apaga a mudança do outro em
silêncio. Com a trava ligada no DAO, o update é condicional pela versão que o cliente carregou (o
`updated_at`, sem migration) e quem salva com a versão antiga recebe 409.

```ts
import {DAOFor, readIfMatch, updateById} from "@mateusseiboth/ts-decorators";

@DAOFor(ImovelModel.tag, {optimisticLock: true}) // versionColumn: "updated_at" por padrão
class ImovelDAO extends BaseDAO {
  async update(data, id) {
    // Prisma 7: o delegate (tx.imovel). Prisma 8: a coleção (tx.orm.public.Imovel).
    const row = await updateById(this.delegate, id, data, {dao: this});
    if (!row) throw notFound("Registro não encontrado para atualização.");
    return row;
  }
}
```

- A versão vem no campo `updated_at` do corpo ou no header `If-Match` (`readIfMatch(req)`, passado
  em `version`; vence o corpo).
- Não casou e o registro existe: `OptimisticLockError` (`statusCode` 409,
  `code: "REGISTRO_ALTERADO"`). Não casou e o registro não existe: `null`.
- Sem versão no pedido: atualiza sem conferir.

### `afterCommit(tx, fn)`

Efeito colateral (e-mail, job, evento) que só pode sair depois do commit: `afterCommit(tx, fn)`
guarda `fn` até o commit da transação aberta por `runInTransaction`, `withTransaction` ou
`Transactional`, e a descarta no rollback. O `ROLLBACK TO SAVEPOINT` do `@TransactionalClass`
descarta só os ganchos da escrita desfeita.

---

### `Transactional` / `@TransactionalClass`

#### `Transactional(prismaClient)` — middleware factory

Wraps an Express handler in a Prisma transaction. Injects the transaction client as `res.locals.tx`. Automatically rolls back if the response status is >= 400 or if an unhandled error is thrown.

```ts
import {Transactional} from "@mateusseiboth/ts-decorators";

router.post("/orders", Transactional(prisma), async (req, res) => {
  // res.locals.tx is the Prisma transaction client
  const controller = new OrderController(res.locals.tx, req.body);
  await controller.create(req, res);
  // commits automatically if status < 400
});
```

#### `@TransactionalClass` — decorator

Wraps `create`, `update`, and `deleteById` with **SQL SAVEPOINTs**, allowing partial rollback within an already-open transaction (`this.DAO.tx`). Methods inherited from a base controller are wrapped too; when the base class is also `@TransactionalClass`, the inherited method is not wrapped again, so each write takes a single savepoint.

```ts
import { TransactionalClass, setTransactionalCompanyFn, addCompanyIdToTransaction } from "@mateusseiboth/ts-decorators";

@TransactionalClass
class OrderController extends BaseController { ... } // create/update/deleteById of BaseController included

// Optional: function the `Transactional(prisma)` middleware above runs right after opening
// its transaction, when `res.locals.entity` is set (e.g. for row-level security)
setTransactionalCompanyFn(addCompanyIdToTransaction);
```

> **ℹ️** `setTransactionalCompanyFn` is only read by the `Transactional(prisma)` middleware (pass `null` to turn it off again). `TransactionalHandler` / `withTransaction` (see [Boot wiring](#boot-wiring-handlers)) call `addCompanyIdToTransaction` with the entity from the handler context, which uses the strategy of `setCompanyIdInjector` (see below), and `@TransactionalClass` never calls it. The return value of the function is ignored, so `addCompanyIdToTransaction` can be passed as is.

#### Company id injection (multi-tenant / RLS)

`addCompanyIdToTransaction(tx, id, injector?)`, e por consequência o `TransactionalHandler` /
`withTransaction`, aplica o tenant na transação antes de rodar o handler. A estratégia padrão é

```sql
SELECT set_config('my.company_id', $1, true)  -- o mesmo efeito do SET LOCAL, com o id como parâmetro
```

e serve a transação do Prisma 7 (`tx.$executeRawUnsafe(sql, id)`) e a do Prisma 8
(`tx.execute(plan)`, montado por `db.raw.sql` com o id interpolado como valor; exige
`configurePrisma8`). O id vai como TEXTO: UUID passa intacto, e o id numérico grava o mesmo
`"42"` que o antigo `SET LOCAL "my.company_id" = 42`. Transação que não é de nenhum dos dois falha
alto. A estratégia é trocável no bootstrap, igual ao `setPrismaClient`:

```ts
import {
  noopCompanyIdInjector,
  rawParamStatementPlan,
  resetCompanyIdInjector,
  setCompanyIdInjector,
} from "@mateusseiboth/ts-decorators";

// Sua convenção: outra variável, outro banco, uma stored procedure...
setCompanyIdInjector(async (tx, companyId) => {
  await tx.$executeRawUnsafe("SELECT set_config('app.tenant', $1, true)", String(companyId));
});

// O mesmo no Prisma 8:
setCompanyIdInjector((tx, companyId) =>
  tx.execute(rawParamStatementPlan`SELECT set_config('app.tenant', ${String(companyId)}, true)`),
);

setCompanyIdInjector(noopCompanyIdInjector); // desliga a injeção
resetCompanyIdInjector();                    // volta para o padrão do pacote
```

Por rota, quando um endpoint precisa de outra estratégia (vale também para o `TransactionalHandler`
e para o middleware `Transactional(prisma)`):

```ts
router.post("/orders", withTransaction(handler, { action: "create" }, {
  companyIdInjector: (tx, companyId) =>
    tx.$executeRawUnsafe("SELECT set_config('my.other_id', $1, true)", String(companyId)),
}));
```

| Function                   | Description                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| `setCompanyIdInjector(fn)` | Troca a estratégia global: `fn(tx, companyId)`                                 |
| `getCompanyIdInjector()`   | A estratégia em uso                                                            |
| `resetCompanyIdInjector()` | Volta para o padrão do pacote                                                  |
| `defaultCompanyIdInjector` | O padrão (`set_config('my.company_id', $1, true)`, Prisma 7 e 8), para reusar  |
| `noopCompanyIdInjector`    | Estratégia vazia: não injeta nada                                              |

> O middleware `Transactional(prisma)` mantém o comportamento opt-in: não injeta nada sem
> `setTransactionalCompanyFn` (ou `companyIdInjector` nas opções dele). `setCompanyIdInjector`
> não o altera. Para ligar o padrão nele: `setTransactionalCompanyFn(addCompanyIdToTransaction)`.


##### When a SAVEPOINT is actually taken

`SAVEPOINT` + `RELEASE` are **two extra round trips to the database per write**. A savepoint opened before the *first* write of a transaction protects nothing: if that write fails, rolling back to it is the same as aborting the whole transaction — which is exactly what the `Transactional` middleware does with the error.

The default policy is still `"always"` (one savepoint per write), because skipping it changes behaviour. The `"auto"` policy is opt-in: the savepoint appears from the **second** write of the same transaction onwards, when there is earlier work worth preserving. With it, the common route (one write per request) stops paying for both round trips.

```ts
import { setSavepointPolicy, getSavepointPolicy } from "@mateusseiboth/ts-decorators";

setSavepointPolicy("always"); // default: one savepoint per write
setSavepointPolicy("auto");   // opt-in: from the 2nd write of the transaction on
setSavepointPolicy("never");  // the transaction is the only unit of rollback
```

> Stay on `"always"` if your code **catches** the error from a write and keeps using the same transaction: without a savepoint, PostgreSQL has already aborted it. The same applies when the route writes directly through `tx` before calling a decorated controller.

---

### `@Validate` / `@WithValidation`

Zod-powered validation of an instance, on demand.

`@WithValidation` (class decorator) only adds two methods to the class: `validate()` and `isValid()`. Both run `schema.parse(this)`. **Nothing is checked in `new`**: the constructor is not intercepted, so an invalid object is created normally and only fails when you call `validate()`.

```ts
import {WithValidation, type IWithValidation} from "@mateusseiboth/ts-decorators";
import {z} from "zod";

const orderSchema = z.object({
  orderId: z.string().uuid(),
  total: z.number().positive(),
});

@WithValidation(orderSchema)
class CreateOrder {
  constructor(
    public orderId: string,
    public total: number,
  ) {}
}

const order = new CreateOrder("not-a-uuid", -1) as CreateOrder & IWithValidation; // no error here
order.isValid(); // → false
order.validate(); // throws ZodError (returns the parsed value when it passes)
```

| Member                | Behaviour                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `validate(schema?)`   | `schema.parse(this)`. Uses the argument, else the schema given to `@WithValidation(schema)` |
| `isValid(schema?)`    | `true` / `false` instead of throwing                                                        |

Used bare (`@WithValidation`, no schema), `validate()` needs a schema as argument; without any schema it throws a plain `Error`.

> **⚠️ `@Validate(schema)` does nothing.** It is a parameter decorator kept only so that older code still compiles (legacy mode, `experimentalDecorators: true`): the schema is ignored and no argument is ever checked. Validate the instance with `@WithValidation(schema)` + `validate()`.

---

### Lifecycle / DI — `@Singleton` / `@Scoped` / `@Transient`

Define o ciclo de vida da instância resolvida pelo `container`.

```ts
import { Singleton, Scoped, Transient, container } from "@mateusseiboth/ts-decorators";

@Singleton()          // uma instância por processo (default)
class ConfigService {}

@Scoped()             // uma instância por chave de escopo (ex.: por request)
class RequestContext {}

@Transient()          // instância nova a cada container.get()
class Report {}

// Definir como a chave de escopo é resolvida (ex.: requestId do AsyncLocalStorage):
container.setScopeResolver(() => getContext()?.requestId ?? "global");
container.clearScope(requestId); // descarta o cache ao finalizar a request
```

---

### `@MaskSensitive` / `applyMask`

Marca campos sensíveis e mascara seus valores em respostas/logs.

```ts
import { MaskSensitive, applyMask } from "@mateusseiboth/ts-decorators";

class User {
  name = "";
  @MaskSensitive() password = "";          // "******"
  @MaskSensitive({ visible: 4 }) cpf = ""; // "*******8901"
}

// Em método: mascara o objeto retornado com base nos campos marcados na classe.
class UserController {
  @MaskSensitive() password = "";
  @MaskSensitive()
  async getById(req, res) { return { password: "secret", name: "Ana" }; }
}

// Ou diretamente (ex.: ao logar):
logger.info(applyMask(user, User));
```

---

### `@RequiresRole`

Autorização por papel em métodos de Controller `(req, res)`. Responde **403** quando o papel falta.

```ts
import { RequiresRole } from "@mateusseiboth/ts-decorators";

class OrderController {
  @RequiresRole("admin")
  async remove(req, res) { ... }

  @RequiresRole(["admin", "fiscal"], { rolesExtractor: (req, res) => res.locals.user.roles })
  async aprovar(req, res) { ... }
}
```

---

### Permissões (`@RequiresPermission` / `configurePermissions`)

O núcleo do módulo de permissões RBAC + ABAC dos apps: catálogo (Models do `@ModelTagged` com o
CRUD, somados ao catálogo do app), motor de condições (`eq`, `ne`, `in`, `gt`, `lt`, `ownerId`),
`authorize`, `isAllowed`, o decorator e a decisão pura do middleware de rota. Fica no app: o
`PERMISSION_CATALOG`, o escopo próprio (almoxarifado), a classe de erro 403 e o middleware de rota.

```ts
import {
  configurePermissions,
  decideRouteAccess,
  METHOD_TO_ACTION,
  RequiresPermission,
} from "@mateusseiboth/ts-decorators";

// bootstrap: a configuração é lida na CHAMADA, a ordem dos imports não importa
configurePermissions<ContextRequest>({
  catalog: PERMISSION_CATALOG,
  getContext, // padrão: getHandlerContext
  resolveSubject: (ctx) => ({
    roles: ctx.user.roles ?? {},
    bypass: ctx.user.admin === true || ctx.user.suporte === true, // o app decide o passe livre
    attributes: { user: ctx.user, entity: ctx.entity, env: { now: Date.now() } },
  }),
  createForbiddenError: (message) => new ForbiddenError(message), // padrão: PermissionDeniedError
  isSameEntity: (ctx) => String(ctx.user.companyId) === String(ctx.entity),
});

class UsuarioService {
  @RequiresPermission("1:trocar-avatar", { resource: ([id]) => ({ ownerId: String(id) }) })
  async updateAvatar(id: string) {}
}

// middleware de rota (do app): null libera, { status, message } recusa
const recusa = decideRouteAccess({ context, tag: model.tag, action: METHOD_TO_ACTION[req.method] ?? "" });
```

- Sem `configurePermissions`, toda checagem lança (falha fechada).
- Tag negativa: passe livre para qualquer usuário autenticado; nunca aparece no catálogo.
- `ownerId` compara como texto e nega quando o dono ou o `user.id` faltam.
- Fora de requisição: `authorize` libera (`authorizeOutsideRequest: "allow"`), `isAllowed` nega
  (`isAllowedOutsideRequest: false`).

---

---

### `@Emit` / `@Listen` + `eventBus`

Publica/assina eventos no barramento singleton (`eventBus`).

```ts
import { Emit, Listen, eventBus, container } from "@mateusseiboth/ts-decorators";

class ReportService {
  @Emit("report.requested")          // emite { result, args, instance } após resolver
  async enqueue(job) { return job; }
}

class ReportWorker {
  @Listen("report.requested")        // assina quando a instância é criada
  async onRequested({ result }) { ... }
}

// TC39: assina automaticamente. Legacy: resolva via container.get (auto) ou chame initListeners(instance).
container.get(ReportWorker);
```

#### Cancelando a assinatura (`@Listen` fora de singleton)

Cada instância que assina deixa um handler vivo no barramento. Em classe
`@Singleton` isso é o esperado — existe uma só. Em `@Scoped` (uma por request) ou
`@Transient` (uma por resolução), sem descarte o `eventBus` cresce sem limite e
todo `emit` passa a chamar também os objetos mortos.

```ts
import { container, disposeListeners, stopCronJobs } from "@mateusseiboth/ts-decorators";

@Scoped(() => getContext().requestId)
class ServicoDoRequest {
  @Listen("pedido.criado") async onCriado(p) { ... }
}

// ao fim do request: descarta as instâncias do escopo E cancela @Listen/@Cron delas
container.clearScope(requestId);

// controle manual, para instâncias criadas fora do container
disposeListeners(instance);
stopCronJobs(instance);
```

`container.clearScope()` e `container.clear()` já chamam `disposeListeners` +
`stopCronJobs` em tudo que soltam. Uma classe `@Transient` que registra
`@Listen`/`@Cron` recebe um aviso no boot — ali ninguém tem a referência para
cancelar depois.

---

### `@Mutex` / `@Semaphore`

Controle de concorrência em métodos.

```ts
import { Mutex, Semaphore } from "@mateusseiboth/ts-decorators";

class Account {
  @Mutex()                       // uma execução por vez (por instância+método)
  async atualizarSaldo() { ... }
}

class ReportManager {
  @Semaphore({ limit: 3 })       // no máx. 3 execuções simultâneas (global por método)
  async gerar(job) { ... }
}
```

As primitivas isoladas também são exportadas: `MutexLock` e `SemaphoreLock`.

---

### `@Cron`

Agenda a execução periódica de um método (intervalo em ms ou expressão cron de 5 campos).

```ts
import { Cron, startCronJobs, container } from "@mateusseiboth/ts-decorators";

class Jobs {
  @Cron("*/5 * * * *")  async limparExpirados() { ... } // a cada 5 min
  @Cron(60_000)         async heartbeat() { ... }       // a cada 60s
}

// TC39: agenda automaticamente. Legacy: resolva via container.get (auto) ou chame startCronJobs(instance).
container.get(Jobs);
```

`stopCronJobs(instance)` para só os timers daquela instância (o descarte de
escopo/transient); `stopAllCronJobs()` para todos.

---

### `@Queue` / `@Processor` + adapters

`@Queue` declara uma fila nomeada sobre um **adapter** com interface comum
(`findMany / findUnique / create / update / delete`, mais o `claim` opcional). `@Processor` consome
essa fila pelo nome.

```ts
import { Queue, Processor, SqliteQueueAdapter, InMemoryQueueAdapter } from "@mateusseiboth/ts-decorators";

@Queue({ name: "reports", adapter: new SqliteQueueAdapter("data/q.db", "reports") })
class ReportQueue {}   // ganha o método enqueue(payload)

class ReportProcessor {
  @Processor("reports", { concurrency: 3, pollMs: 1000 })
  async handle(payload) { ... } // chamado para cada job pendente
}

await (container.get(ReportQueue) as any).enqueue({ id: 1 });
```

Adapters inclusos: `InMemoryQueueAdapter` e `SqliteQueueAdapter`. Qualquer objeto que
implemente a interface `QueueAdapter` (Redis, etc.) funciona.

**Retenção no `SqliteQueueAdapter`.** Job terminado sai da fila depois da retenção: concluído em
7 dias, falha em 30 (`completedRetentionMs`, `failedRetentionMs`; `Infinity` guarda para
sempre). A limpeza roda ao abrir e quando um job termina, no máximo uma vez por
`cleanupIntervalMs` (1 h), ou na hora com `purgeFinished()`. `onPurge` recebe os apagados. O
arquivo para de crescer, mas só diminui com um `VACUUM`.

**Limite por chave** (`keyOf` + `maxPerKey`): `keyOf` extrai uma chave do payload, e a fila
nunca deixa mais de `maxPerKey` jobs da MESMA chave em voo. O default é 1, que serializa a
chave. O job que excede o limite fica `pending` e NÃO ocupa vaga, então o de outra chave passa
na frente. A `concurrency` continua sendo o teto da fila inteira.

```ts
class DuplicacaoProcessor {
  // Cada entidade roda até 3 juntos; a fila inteira, até 6. A quarta da mesma entidade espera.
  @Processor("duplicacoes", {
    concurrency: 6,
    keyOf: (payload) => payload.ctx.entidade,
    maxPerKey: 3,
  })
  async handle(payload) { ... }
}
```

**Concorrência justa por tenant** (`perTenant`): no máximo `concurrency` jobs do MESMO tenant em
`processing`, contados no armazenamento (vale entre processos e durante o deploy), e o worker livre
pega o job do tenant com menos jobs rodando. A geração de um tenant grande não ocupa todos os
workers. O tenant sai de `key(payload)`; sem `key`, o primeiro que existir entre `payload.tenant`,
`payload.ctx.tenant`, `payload.ctx.entity`, `payload.companyId` e `payload.user.entidade` (o
`ReportUser`). Job sem tenant não tem limite. Não combina com `keyOf`. Vale também no
`ReportEngine` (opção `perTenant`).

```ts
@Processor("remessas", { concurrency: 8, perTenant: { concurrency: 2, key: (p) => p.academiaId } })
async handle(payload) { ... }
```

**Reserva do job e job órfão** (`claim`, `lockedAt`, `staleAfterMs`): antes de rodar, a fila
reserva o job com `adapter.claim(id, lockedAt)`, que o leva de `pending` para `processing` numa
operação só e devolve `false` quando outro processo já levou. O `InMemoryQueueAdapter` e o
`SqliteQueueAdapter` implementam (no SQLite é um `UPDATE ... WHERE status = 'pending'`), então dois
processos na mesma tabela não rodam o mesmo job. Adapter próprio sem `claim` continua funcionando
(a fila lê e depois grava), mas sem essa garantia.

O job em andamento renova o `lockedAt` (epoch em ms, só existe em `processing`) a cada um terço do
`staleAfterMs`. O job `processing` que ficou `staleAfterMs` sem renovar, ou que não tem `lockedAt`
(gravado por versão anterior), é de um processo que caiu: volta para `pending` no ciclo seguinte e
roda de novo. O job em andamento neste processo nunca é dado como órfão, por mais que demore, e
pausar (`pauseProcessors`) também não o torna órfão. Ao terminar (`completed` ou `failed`) o
`lockedAt` é limpo.

```ts
class ReportProcessor {
  // padrão: 60000. Nunca vale menos que três ciclos de pollMs.
  @Processor("reports", { pollMs: 1000, staleAfterMs: 120_000 })
  async handle(payload) { ... }
}
```

Adapter próprio precisa guardar o `lockedAt` no `create`/`update` e devolvê-lo no
`findMany`/`findUnique`, senão o job de outro processo vivo parece órfão. No `SqliteQueueAdapter`
a tabela tem a coluna `lockedAt`, e o banco criado por versão anterior recebe a coluna sozinho ao
abrir. Job que LANÇA vai para `failed`: não há nova tentativa automática (use `retryQueueJob`).

Funções do registry (para drain de deploy e testes): `enqueue(nome, payload)`,
`startProcessors()`, `stopProcessors()`, `pauseProcessors()`/`resumeProcessors()`
(drain: para de PUXAR novos jobs, os em voo terminam), `getInFlightCount()`,
`isProcessingPaused()`, `getQueueAdapter(nome)`, `clearQueues()`.

**Estado e operação das filas** (health check e painel de administração):

```ts
listQueues(); // ["iptu-geracao", "reports", ...]
await getQueueStats(); // [{ name, hasProcessor, running, paused, concurrency, inFlight, counts }]
await getQueueJobs("reports", { status: "failed", limit: 50 }); // mais recentes primeiro
await retryQueueJob("reports", id); // falho volta para pendente, sem o erro
await removeQueueJob("reports", id); // recusa job em processamento
await purgeQueue("reports", "completed"); // só "completed" ou "failed"; devolve quantos saíram
```

`counts` traz `pending`, `processing`, `completed` e `failed`. Os métodos opcionais do adapter
`countByStatus`, `findRecent` e `deleteByStatus` evitam ler a fila inteira. O `SqliteQueueAdapter`
implementa os três; o `InMemoryQueueAdapter` só tem o `countByStatus`. Sem eles, o registry usa o
`findMany`.

---

## Resiliência e operação

Decorators para efeito colateral depois do commit, falha transitória, trava entre instâncias,
medição e desligamento em ordem. Todos têm a versão em função (`withRetry`, `withTimeout`...).

### `@AfterCommit` / `afterCommit`

O `@Emit` publica quando o método retorna, que dentro de uma transação é ANTES do commit: se a
transação voltar atrás, o e-mail e o job já saíram. O `@AfterCommit` segura o evento até o commit e
o descarta no rollback. Mesmo payload do `@Emit` (`{ result, args, instance }`).

```ts
class ParcelaService {
  @AfterCommit("parcela.quitada")
  async quitar(id: string) { return parcela; }
}

afterCommit(tx, () => enqueue("certidoes", { id })); // sem decorator
```

Vale para a transação aberta por `runInTransaction`, `withTransaction` ou `Transactional`. O
`ROLLBACK TO SAVEPOINT` do `@TransactionalClass` descarta só os ganchos da escrita desfeita. Sem
transação, roda na hora.

### `@Retry` / `@Timeout` / `@CircuitBreaker`

```ts
class ESocialClient {
  @Retry({ attempts: 3, delayMs: 500 })                          // 500 ms, 1 s, com sorteio
  @CircuitBreaker({ failureThreshold: 5, resetAfterMs: 30_000 }) // fora do ar: falha na hora
  @Timeout(10_000)                                               // cada tentativa tem 10 s
  async sendLote(lote: Lote) {
    return fetch(url, { body, signal: getTimeoutSignal() });     // o fetch é cancelado de verdade
  }
}
```

Os decorators valem de baixo para cima: o mais perto do método é o mais interno. Nesta ordem, cada
tentativa conta para o circuito e tem o próprio prazo, e quando o circuito abre o `@Retry` para na
hora (`CircuitOpenError` não é repetido). `withRetry`, `withTimeout` e `withCircuitBreaker` são as
versões em função; `getCircuits()` mostra o estado de cada circuito.

### `@SingleFlight`

Chamadas iguais que chegam enquanto a primeira está em andamento recebem a mesma promessa. Não é
cache: ao terminar, a próxima chamada roda de novo. Junto do `@Cacheable`, evita que todo mundo
bata no banco quando o cache vence.

```ts
@SingleFlight({ key: (moeda) => moeda })
async findCotacao(moeda: string) { ... }
```

### `@IdempotentMethod` / `withIdempotency`

Para onde o middleware `Idempotent` não chega: mensagem que a fila entrega duas vezes, job
refeito. Mesma chave em voo divide a execução; concluída dentro de `ttlMs` (default 10 min)
devolve o resultado guardado sem rodar; falha não é guardada. O tenant do contexto
(`getHandlerContext`) entra na chave. Fica na memória do processo: não sobrevive a reinício nem
vale entre instâncias (o que precisa valer sempre fica numa restrição do banco).

```ts
@IdempotentMethod({ key: (mensagem) => mensagem.id })
async onPagamento(mensagem: MensagemDePagamento) { ... }

await withIdempotency(`lote-iptu:${exercicio}`, () => createLote(exercicio), { ttlMs: 60_000 });
```

O nome não é `@Idempotent` porque `Idempotent` já é o middleware (mesmo par de
`RateLimit`/`RateLimitMethod`).

### `@AdvisoryLock`

Trava no banco, que vale entre instâncias (o `@Mutex` vale só no processo). Postgres com
`pg_advisory_xact_lock` (Prisma 7 e 8), MySQL com `GET_LOCK`/`RELEASE_LOCK` (Prisma 7). Sempre na
transação em uso (contexto do handler, `this.DAO.tx` ou `this.tx`).

```ts
configureAdvisoryLock({ dialect: "mysql" }); // default "postgres"

@AdvisoryLock({ key: (banco) => `remessa:${banco}`, waitMs: 5_000 })
async gerarRemessa(banco: string) { ... }
```

A chave vira um hash de 64 bits e nunca entra no SQL como texto. Estourou o `waitMs`:
`AdvisoryLockTimeoutError`.

### `@Timed`

Duração de cada chamada em memória: contagem, erros, mínimo, máximo e p50/p95/p99 das últimas
1.000. `onTiming(listener)` repassa cada amostra (log, painel próprio). Com o SDK do
OpenTelemetry registrado, cada chamada também vira um ponto do histograma `app.method.duration`
(segundos), com `code.function`, `outcome` (`ok`/`erro`), o `tenant` do contexto e os rótulos de
`labels(...args)`. `buckets` próprios pedem `metric` próprio.

```ts
@Timed({ slowMs: 2_000, labels: (tipo: string) => ({ tipo }) }) // acima de 2 s sai no log como lenta
async calcularIptu(tipo: string, inscricao: string) { ... }

getTimings(); // [{ name: "IptuService.calcularIptu", count, errors, p95Ms, ... }]
```

### `@Trace` / `withSpan`

Span do OpenTelemetry em volta da chamada: nome `Classe.metodo` (ou `name`), atributo
`app.entity` com o tenant do contexto e os de `attributes(...args)`. Erro vira
`recordException` + status ERROR e é relançado. No método assíncrono, o span fecha quando a
promessa termina; o síncrono continua síncrono.

`@opentelemetry/api` é dependência opcional, carregada na primeira chamada: sem ela instalada, o
decorator só chama o método. Quem exporta os spans (Jaeger) é o SDK do app.

```ts
@Trace({ attributes: (competencia: string) => ({ competencia }) })
async calcularFolha(competencia: string) { ... }

await withSpan("esocial.sendLote", () => client.sendLote(lote), { attributes: { eventos: 50 } });
```

### Métricas (OpenTelemetry)

Histograma, contador e gauge sem importar o `@opentelemetry/api`: sem ele, ou sem SDK, tudo é
no-op. O instrumento nasce na primeira gravação e é refeito quando o MeterProvider global muda.
Rótulo é só valor de poucas opções: nunca id, path cru, mensagem de erro ou usuário.

```ts
recordMetric({ name: "app.remessa.duration", value: segundos, unit: "s" });
incrementMetric({ name: "app.boleto.emitido", attributes: { banco, ...getTenantLabel() } });
const desligar = registerGauge({ name: "app.remessa.pendente", observe: () => fila.length });

@Counted({ labels: (banco: string) => ({ banco }) }) // contador app.method.calls
async receberWebhook(banco: string, corpo: unknown) { ... }
```

O pacote grava as próprias métricas: fila (`queue.job.*`, `queue.jobs`), trava do banco
(`app.advisory_lock.wait.duration`), idempotência, trava otimista, permissão negada, falha da
auditoria, relatório, drain, saúde e processo (`process.*`). `registerDefaultMetrics()` liga os
gauges e as métricas do processo (o `startObservability` já chama); `recordAppError(err, {
statusCode })` vai no `errorHandler` do app. O banco do Prisma 8 entra pelo middleware nativo do
runtime:

```ts
export const db = postgres({ contract, url, middleware: [createPrisma8Metrics()] });
```

Buckets (s): `BUCKETS_HTTP` (5 ms a 60 s), `BUCKETS_DB` (0,5 ms a 10 s), `BUCKETS_QUEUE` (50 ms a
30 min) e `BUCKETS_PADRAO`, por instrumento, que o SDK usa nas Views. A lista completa, com
rótulos, está em `src/observability/catalog.ts` e `src/observability/buckets.ts`.

### `@Deprecated`

Rota obsoleta ganha `Deprecation` (RFC 9745), `Sunset` (RFC 8594) e `Link rel="deprecation"`, e um
aviso no log por rota. Com `blockAfterSunset`, responde 410 depois da data.

```ts
@Deprecated({ sunset: "2027-01-31", link: "https://docs/v2/imoveis", message: "use GET /v2/imoveis" })
async list(req: Request, res: Response) { ... }

router.use("/v1", deprecatedMiddleware({ sunset: "2027-01-31" }));
```

### `@Config` / `defineConfig`

Variáveis de ambiente validadas com zod na subida. Tudo que falta ou está errado sai de uma vez,
pelo nome da variável e sem o valor. O resultado é congelado.

```ts
export const env = defineConfig(
  z.object({ DATABASE_URL: z.url(), PORT: z.coerce.number().int().default(3000) }),
);

@Config(EnvSchema) // para injetar pelo container; os campos são só declaração
class AppConfig {
  declare readonly DATABASE_URL: string;
  declare readonly PORT: number;
}
```

### `@OnShutdown` / `enableGracefulShutdown`

No SIGTERM/SIGINT: para de aceitar conexões, para de puxar jobs e espera os em voo, para o cron e os
processadores, encerra a engine de relatórios e roda os ganchos, do menor `order` para o maior.
Cada passo tem prazo, e o erro de um não interrompe os outros.

```ts
const server = app.listen(port);
enableGracefulShutdown({ server, drainTimeoutMs: 25_000 });
onShutdown("prisma", () => prisma.$disconnect(), { order: 900 });

class WebhookService {
  @OnShutdown({ order: 50 })
  async flushPendentes() { ... }
}
```

**Drenagem com o servidor no ar** (deploy que drena antes de trocar o container): o CI chama
`POST /internal/drain` (cabeçalho `x-drain-token`, conferido com o `DRAIN_TOKEN`; sem token, com
`NODE_ENV=production` os POST respondem 401, e fora de produção a rota fica aberta; o log avisa), faz poll em `GET /health/lifecycle` até `"ready":true` e só então manda
o SIGTERM. Durante a drenagem, POST/PUT/PATCH/DELETE recebem 503 com `Retry-After: 5` e
`code: "SERVER_DRAINING"`, GET segue, e o `/ready` responde 503. `POST /internal/drain/cancel`
desfaz e retoma as filas.

```ts
app.use(createDrainRouter());           // /health/lifecycle, /internal/drain e /cancel
app.use(rejectWritesWhenDraining());    // antes das rotas
const server = app.listen(port);
// drenagem -> servidor -> cron e processadores -> relatórios -> ganchos
enableGracefulShutdown({ server, drainBeforeClose: true, drainTimeoutMs: 120_000 });
```

`beginDrain`, `cancelDrain`, `isDraining` e `getDrainStatus` expõem o mesmo estado no código.

### `@HealthCheck` / `createHealthRouter`

`/health` responde se o processo está vivo; `/ready` roda as sondas (em paralelo, com prazo) e
responde 503 se uma crítica falhar ou se o app estiver drenando ou desligando.

```ts
app.use(createHealthRouter());

class InfraChecks {
  @HealthCheck({ name: "banco", timeoutMs: 2_000 })
  async checkBanco() { await prisma.$queryRaw`SELECT 1`; }

  @HealthCheck({ name: "servico-de-email", critical: false })
  async checkEmail() { ... }
}
```

---

---

## Roteamento por arquivos — `@GlobalRouter` / `@RegistryRouter`

A PASTA define o path: o servidor varre uma árvore de rotas e monta cada
`index.ts` que exporta `registry(router)`. No fim da varredura o log de boot mostra UMA tabela (rota,
quantidade de endpoints e verbos), e o registro fica em `getRegisteredRoutes()` para health
check; `formatRoutesTable(rotas)` é a função pura que monta a tabela. O mesmo registro, por caminho de
montagem, fica em `AllRouters` (`{ path, file, globalMiddlewares, routeMiddlewares, endpoints }`). Ex.:
`src/http/routes/patrimonio/api/v1/baixa/index.ts` → `/patrimonio/api/v1/baixa`.

```ts
// src/http/server.ts
import express from "express";
import {GlobalRouter, RegistryRouter} from "@mateusseiboth/ts-decorators";

@GlobalRouter()
export class HttpServer {
  app = express();

  // Varre src/http/routes/api e monta cada index.ts sob o prefixo /api,
  // aplicando os middlewares na ordem dada.
  @RegistryRouter({folder: "routes/api", prefix: "/api", middlewares: [withContext, express.json()]})
  async apiReady() { /* chamado após montar este grupo */ }

  async init() {
    await (this as any).initializeRoutes(); // adicionado pelo @GlobalRouter
    this.app.listen(3000);
  }
}
```

```ts
// src/http/routes/api/v1/categoria/index.ts  →  /api/v1/categoria
import type {Router} from "express";

export const registry = (router: Router) => {
  router.get("/", listar);       // GET /api/v1/categoria
  router.post("/", criar);
};
// opcional: middlewares específicos deste recurso
export const middlewares = [meuMiddlewareDeModulo];
```

O middleware que vale para o MÓDULO inteiro mora no `_middlewares.ts` da pasta, e não se repete
em cada `index.ts`. Ele vale para a pasta e todas as de baixo, antes do `middlewares` da rota; o
mesmo middleware em mais de um nível roda uma vez.

```ts
// src/http/routes/api/v1/_middlewares.ts  →  vale para tudo em /api/v1/*
export const middlewares = [meuMiddlewareDeModulo];

// src/http/routes/api/v1/upload/index.ts: multipart, o corpo só existe depois do multer
export const inheritFolderMiddlewares = false;
```

Peças relacionadas:

| Export              | Papel                                                                             |
| ------------------- | --------------------------------------------------------------------------------- |
| `folderRouter(app, pasta, {prefix, middlewares})` | O scanner em si — use direto se não quiser os decorators |
| `AllRouters` | `Record<caminho, MountedRouter>` com toda rota montada, para listar no boot |
| `getRegisteredRoutes()` / `clearRegisteredRoutes()` / `endpointsOf(router)` / `formatRoutesTable(rotas)` | O registro em ordem de montagem, os endpoints de um router e a tabela do log |
| `validateRouteFile(caminho)` | Recebe o CAMINHO do arquivo e confere pelo texto, sem importar: devolve `false` quando não acha `export function registry` ou `export const registry`, e lança erro quando o arquivo contém um padrão proibido (`child_process`, `eval(`, `new Function`, `while(true)`, `process.exit`) |
| `RouteBuilder(router, defaults)` | Builder com middlewares default por grupo: `.extend([mw])` cria um sub-builder que aplica `mw` em toda rota registrada (`get/post/put/delete/use`) — ideal para grupos autenticados |

```ts
const base = new RouteBuilder(router);
const comAuth = base.extend([checkAuth, checkPermissions]);
comAuth.get("/relatorios", handler);   // roda checkAuth + checkPermissions antes
comAuth.use(subRouterProtegido);       // sub-router inteiro atrás da auth
```

---

## HTTP Routing declarativo — `@Get` / `@Rest`

Camada de rotas sobre o Express. O fluxo base (`@GlobalRouter` → `folderRouter` →
`registry(router)` → `RouteBuilder`) continua igual; estes helpers deixam você
**declarar** as rotas em vez de escrevê-las na mão em cada `Registry`.

### `RouteBuilder`

Envolve um `Router` do Express aplicando um conjunto de middlewares padrão a cada
rota registrada. `extend()` cria um novo builder com middlewares adicionais — a base
para variantes como "com paginação" ou "com permissões".

```ts
import {RouteBuilder} from "@mateusseiboth/ts-decorators";

const route = new RouteBuilder(router);
route.get("/:id", handler);              // aplica os middlewares padrão + handler
const paginated = route.withPrismaOptions(Model); // novo builder: getOrderBy + getWhere + getColumns + getPaginate
```

Você pode estender a classe para adicionar composições próprias (auth, permissões, etc.):

```ts
export class ExtendedRouterBuilder extends RouteBuilder {
  withAuthAndPermissions(model: {tag: number}): ExtendedRouterBuilder {
    return this.extend([(req, res, next) => checkPermissions(req, res, next, model)]) as ExtendedRouterBuilder;
  }
}
```

### `@Get` / `@Post` / `@Put` / ... (rotas estilo NestJS)

Decoram **métodos do controller** com verbo HTTP + path (com params, ex.: `@Get(":id/carne")`).
A metadata é lida depois por `applyControllerRoutes`, que registra cada rota no
`RouteBuilder` apropriado. Verbos disponíveis: `@Get`, `@Post`, `@Put`, `@Patch`,
`@Delete`, `@Options`, `@Head`, `@All`.

```ts
import {Get, Post, Put, Delete} from "@mateusseiboth/ts-decorators";

@Injectable()
export class LoteController extends BaseController {
  @Get("/", {use: "routeWithPaginate", action: "LIST"})
  async get(req, res, next) { ... }

  @Post("/", {use: "routeWithExtraInfo", action: "CREATE"})
  async create(req, res, next) { ... }

  @Put("/:id", {action: "UPDATE"})
  async update(req, res, next) { ... }

  @Delete("/:id", {use: "routeWithIdempotency", action: "DELETE"})
  async deleteById(req, res, next) { ... }

  @Get("/:id/carne", {action: "GET"})
  async getById(req, res, next) { ... }
}
```

Cada decorator aceita `(path?, options?)`. As `options`:

| Campo   | Efeito                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------- |
| `use`   | Nome da propriedade `RouteBuilder` no registry (`route`, `routeWithPaginate`, ...). Default `route`          |
| `build` | `(builder, def) => builder` — transforma o builder **só nesta rota** (ex.: `b => b.withPrismaOptions(Model)`) |
| _resto_ | Metadata livre repassada ao `wrap` (ex.: `action` para auditoria)                                            |

### `@Rest` — CRUD declarativo

Decorator de **classe** no `Registry` que semeia o CRUD padrão sem escrever cada
rota. Reproduz a convenção do `BaseRegistry`:

| Ação     | Verbo  | Path   | Controller     | `use`                   | `action` |
| -------- | ------ | ------ | -------------- | ----------------------- | -------- |
| `list`   | GET    | `/`    | `get`          | `routeWithPaginate`     | `LIST`   |
| `get`    | GET    | `/:id` | `getById`      | `route`                 | `GET`    |
| `create` | POST   | `/`    | `create`       | `routeWithExtraInfo`    | `CREATE` |
| `update` | PUT    | `/:id` | `update`       | `routeWithExtraInfo`    | `UPDATE` |
| `delete` | DELETE | `/:id` | `deleteById`   | `routeWithIdempotency`  | `DELETE` |

```ts
import {Rest} from "@mateusseiboth/ts-decorators";

@Injectable()
@Rest() // gera as 5 rotas acima
export class Registry extends BaseRegistry {
  constructor(protected readonly controller: LoteController) {
    super(controller);
  }
}
```

Ajuste o preset com `only` / `except` / `overrides`:

```ts
@Rest({
  except: ["delete"],                                        // não gera DELETE
  overrides: {
    list: {path: "/todos", use: "routeWithPaginate"},        // muda path/builder
    get:  {options: {build: (b) => b.withPrismaOptions(Model)}}, // builder custom pontual
  },
})
```

- Ações cujo **handler não existe** no controller são ignoradas com um aviso.
- `getRestRoutes(RegistryClass)` devolve as `RouteDefinition[]` resolvidas (mesmo formato de `@Get`).
- `REST_PRESET` é a tabela padrão exportada, caso queira inspecioná-la/reusá-la.

### Ligando tudo no BaseRegistry

`applyControllerRoutes` lê as rotas (do `@Rest` e/ou dos `@Get`/`@Post`) e as registra,
substituindo o `declareRoutes()` manual. Escreva **uma vez** no seu `BaseRegistry`:

```ts
import {
  applyControllerRoutes,
  getRestRoutes,
  getControllerRoutes,
  RouteBuilder,
} from "@mateusseiboth/ts-decorators";

declareRoutes() {
  applyControllerRoutes({
    controller: this.controller,
    // @Rest do registry  +  rotas custom (@Get/@Post) do controller
    routes: [...getRestRoutes(this), ...getControllerRoutes(this.controller)],
    // resolve `use` para as propriedades montadas no configure()
    resolveBuilder: (use) => (use ? (this as any)[use] : this.route) as RouteBuilder,
    // wrapper padrão: transação + try/catch + auditoria por action
    wrap: (def, invoke) =>
      withTransaction(
        async (req, res, next) => {
          try {
            await invoke(req, res, next);
          } catch (err) {
            next(err);
          }
        },
        {action: def.options.action},
      ),
  });
}
```

O `configure()` de cada `Registry` continua sendo o lugar onde você monta os builders
(inclusive um `ExtendedRouterBuilder` com métodos custom); o `use` só referencia o nome
da propriedade:

```ts
configure(router: Router) {
  this.routeBase = new ExtendedRouterBuilder(router);
  this.route = this.routeBase.withAuthAndPermissions(LoteModel);
  this.routeWithExtraInfo = this.route;
  this.routeWithPaginate = this.route.withPrismaOptions(LoteModel);
  this.routeWithIdempotency = this.route;
}
```

`applyControllerRoutes` também pode ser usado sem `routes` — nesse caso lê apenas as
rotas decoradas no próprio controller. Se `wrap` for omitido, o método do controller é
chamado diretamente.


---

### Registry e controllers: `respond`, OpenAPI, `mergeParams` e container por app

```ts
// pasta montada com o param da academia
@GlobalRouter()
export class Server extends GlobalRouterApp {
  app = express();
  @RegistryRouter({ folder: "src/routes", prefix: "/academias/:academiaId", mergeParams: true })
  rotas() {}
}
await new Server().initializeRoutes(); // sem cast

// rotas do registry, com a resposta depois do commit
applyControllerRoutes({
  controller,
  routes: listRouteDefinitions(this),
  resolveBuilder: (use) => this[use ?? "route"],
  wrap: (def, invoke) => (req, res, next) => withTransaction(() => invoke(req, res, next)),
  respond: (result, _req, res) => res.json({ data: result }),
});

// OpenAPI: método, caminho, handler e `options.doc` de cada rota
for (const rota of listRouteDefinitions(registry)) gerarOperacao(rota.method, rota.path, rota.options.doc);

// container por teste e dependência que não é classe
const RELOGIO = createToken<Relogio>("Relogio");
@Injectable()
class Agenda {
  constructor(@Inject(RELOGIO) readonly relogio: Relogio) {}
}
const c = createContainer();
c.register(RELOGIO, { agora: () => Date.now() });
c.get(Agenda);
```

- **Container do app na montagem:** `folderRouter(app, pasta, { container })` ou
  `@RegistryRouter({ folder, container })`; o `index.ts` de cada pasta recebe
  `registry(router, { container })` e resolve o registry por ele.
- **`respond` nas rotas do `declareRoutes()`:** `new RouteBuilder(router, [], { respond })` aplica o
  mesmo gancho a toda rota do builder (e dos do `extend`). O `respond` roda depois que o último
  handler termina, sempre que ninguém respondeu e o handler não chamou `next`, inclusive com
  `undefined`. O handler precisa devolver (ou aguardar) o próprio trabalho.
- **`listRouteDefinitions` inclui o `declareRoutes()`:** `this.route.post("/:id/ativar", { doc }, handler)`
  anota a rota no builder (`route.definitions()`).
- `@Get("/:id", { doc: { summary: "Aluno pelo id", tags: ["alunos"] } })`: o `doc` é livre (zod,
  JSON Schema...), o pacote só guarda.
- `RouteBuilder` pode ser estendido: `router` e `defaultMiddlewares` são `protected` e o `extend`
  devolve a subclasse.

---

## Boot wiring (handlers)

O pacote não importa Prisma nem conhece o contexto do app — o app injeta tudo UMA
vez no boot, via setters:

```ts
// src/index.ts (boot do app)
import * as commons from "@mateusseiboth/ts-decorators";
import prismaClient from "@database/prisma";
import * as context from "@middlewares/context"; // AsyncLocalStorage do app

commons.setPrismaClient(prismaClient as any);                       // usado por @Transactional/withTransaction
commons.setHandlerContext(context.getContext, context.requireContext); // contexto por request
commons.setTransactionalCompanyFn(commons.addCompanyIdToTransaction);  // opcional: RLS também no middleware Transactional(prisma)
// commons.setCompanyIdInjector(minhaEstrategia);                    // opcional: outra convenção de tenant
commons.setAuditStorage(meuAuditAdapter);                            // opcional: destino do @Auditable
```

| Export | Descrição |
| ------ | --------- |
| `setPrismaClient(client)` / `getPrismaClient()` | Injeta o client Prisma do app (o gerado em `src/prisma/generated`) |
| `setHandlerContext(get, require?)` / `getHandlerContext()` / `requireHandlerContext()` | Provedor do contexto por request (user, entidade, exercicio, transaction) |
| `setTransactionalCompanyFn(fn)` | Chamada só pelo middleware `Transactional(prisma)`, quando há `res.locals.entity`. Normalmente `addCompanyIdToTransaction` (RLS), que pode ser passada direto. O `TransactionalHandler`/`withTransaction` não usa esta função: chama `addCompanyIdToTransaction` com a entidade do contexto |
| `setCompanyIdInjector(fn)` | Estratégia de tenant usada por `addCompanyIdToTransaction` (padrão: `set_config('my.company_id', $1, true)`, Prisma 7 e 8). Veja [Company id injection](#company-id-injection-multi-tenant--rls) |
| `withTransaction(handler, {action}?, opts?)` | Envolve um handler Express em `prisma.$transaction` + RLS + auditoria: `router.post("/", withTransaction(criar, {action: "CREATE"}))` |
| `compose(...wrappers)` | Composição de wrappers de handler (é como `withTransaction` é construído: `compose(TransactionalHandler(opts), Audit(action))(fn)`) |
| `TransactionalHandler(opts)` / `Audit(action)` | As peças individuais, se você quiser compor diferente |
| `AuditLogger` | Storage em SQLite da auditoria HTTP, usado pelo `Audit`/`withTransaction`. O `log()` recebe a entrada da requisição (`method`, `url`, `statusCode`...), que não é o `AuditEntry` do `@Auditable`: para usar com `setAuditStorage` é preciso um adaptador (veja [Auditoria HTTP em lote](#auditoria-http-em-lote-auditlogger)) |

---

## Observabilidade (`@mateusseiboth/ts-decorators/observability`)

Traces para o Jaeger e métricas para o Prometheus (OTLP gRPC até o otel-collector), logs em JSON
no stdout para o Loki. Os pacotes do SDK do OpenTelemetry vêm com o ts-decorators: o projeto não
precisa declarar os seus.

```jsonc
// package.json: o SDK sobe ANTES do código do projeto, só no processo do servidor
"start": "bun --preload @mateusseiboth/ts-decorators/observability/preload src/index.ts"
```

No Dockerfile, o mesmo `--preload` no `CMD`. NÃO coloque no `bunfig.toml`: lá ele roda em todo
comando `bun` do repositório (CLI do Prisma, scripts, healthcheck), e o console desses comandos
vira JSON. O `--preload` da linha de comando roda depois dos preloads do bunfig, então quem carrega
o env continua antes.

```ts
import { observeHttp } from "@mateusseiboth/ts-decorators/observability";

app.use(withContext);     // o middleware de contexto do projeto, se houver
app.use(express.json());
app.use(observeHttp());   // rota, tenant, request id, métricas HTTP e log de acesso
```

| Env | Default | Uso |
| --- | --- | --- |
| `OTEL_ENABLED` | `true` | `"false"` desliga o SDK (o legado `OTEL_TRACING_ENABLED="false"` também) |
| `OTEL_SERVICE_NAME` | obrigatório | `service.name` |
| `OTEL_SERVICE_VERSION` | `npm_package_version` ou `0.0.0` | `service.version` |
| `DEPLOY_ENV` | `NODE_ENV` ou `development` | `deployment.environment.name` |
| `OTEL_EXPORTER_OTLP_{TRACES,METRICS}_ENDPOINT` | `http://localhost:4317` | coletor |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` | `otlp` | `console` imprime uma linha JSON por span/métrica; `none` desliga |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | ms |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` / `OTEL_BSP_MAX_QUEUE_SIZE` | `20` / `512` | lote de spans |
| `LOG_LEVEL` | `info` (cai para `TS_COMMONS_LOG_LEVEL`) | nível do logger |
| `LOG_FORMAT` | `json` em produção, `pretty` fora | formato do stdout |

- **Por que o preload:** no Bun, o `import` do Express não passa pelo `require` que as
  instrumentações enganchar. O preload sobe o SDK e carrega `https`, `http` e `express` pelo
  `require`; o `import` do projeto recebe a cópia instrumentada (span SERVER com `http.route`).
- **Um span SERVER por requisição:** o `observeHttp` completa o da instrumentação HTTP e, quando
  ela não abriu nenhum, abre o dele, filho do `traceparent`/`X-Trace-Id` que chegou. `/health*`,
  `/internal/drain*` e `/metrics` ficam fora do trace (a lista é o `ignorePaths`).
- **Propagação:** `traceparent` continua o trace; sem ele, o `X-Trace-Id` do gateway vira o trace
  id. O `fetch` global sai com `traceparent`, `X-Trace-Id` e `x-request-id`.
- **Corpo no span:** desligado; as escritas de um controller `@Auditable` (ou `markBodyCapture(req)`)
  gravam os dois corpos inteiros, credenciais mascaradas, até 1 MB por atributo.
- **Console:** `console.log/info/warn/error/debug` saem pelo `logger` (opção `patchConsole`).

Opções em `startObservability(options)` e `observeHttp(options)` (`src/observability/options.ts`).

---

## Performance & logging

### Log levels

Os decorators rodam em caminho quente — uma vez por request, às vezes por campo.
Um `console.log` ali custa formatação de string e I/O síncrono em **toda**
requisição, mesmo sem ninguém lendo. Todo log interno do pacote passa por um
logger com nível; os de diagnóstico (`Cache HIT`, `SAVEPOINT criado`,
`Initializing fields`, descoberta de rotas) são `debug` e ficam **mudos** por
padrão.

```ts
import { setLogLevel, getLogLevel, logger } from "@mateusseiboth/ts-decorators";

setLogLevel("debug");   // liga o diagnóstico dos decorators
setLogLevel("silent");  // cala tudo
```

| Nível    | Mostra                                                        |
| -------- | ------------------------------------------------------------- |
| `silent` | nada                                                          |
| `error`  | falhas                                                        |
| `warn`   | + avisos (`@Transient` com `@Listen`, configuração)            |
| `info`   | **padrão** — + `[ROUTE] ...` e o `this.log()` do `@logDecorator` |
| `debug`  | + cache hits, savepoints, registro de model, RLS por transação |

Também dá para configurar por env, sem tocar no código:

```bash
TS_COMMONS_LOG_LEVEL=debug bun run src/index.ts
```

Em log próprio, prefira a forma preguiçosa — a mensagem só é construída se o
nível estiver ligado:

```ts
logger.debug(() => `payload: ${JSON.stringify(payload)}`);
```

### Cache de metadata

`@Field`, `@NestedModel` e `@MaskSensitive` guardam metadata reflexiva que só
muda quando uma classe é **declarada**. Resolver isso percorre a cadeia de
protótipos e lê `Symbol.metadata`; antes acontecia a cada requisição
(`getWhere`/`getColumns`/`getOrderBy`) e a cada campo convertido
(`@AutoConvert`).

Agora o resultado é memorizado por classe e invalidado sozinho quando um
registro novo aparece. Duas consequências para quem consome:

- **`getFieldTypes()` e `collectFieldMeta()` devolvem estruturas congeladas e
  compartilhadas.** Trate como somente leitura; copie antes de alterar.
- `collectFieldMeta` percorre o **prototype** do model aninhado — não instancia
  mais `new Model()` por requisição só para descobrir nomes de campo.

```ts
import { clearMetadataCache } from "@mateusseiboth/ts-decorators";

clearMetadataCache(); // testes / hot reload — a próxima leitura recalcula
```

### Auditoria HTTP em lote (`AuditLogger`)

O `AuditLogger` monta a linha na hora do request (o body pode ser mutado depois)
e adia a ida ao disco: as entradas vão para um buffer e são gravadas **em lote**,
numa transação só, com o statement preparado uma vez.

```ts
import { AuditLogger } from "@mateusseiboth/ts-decorators";

AuditLogger.configure({ path: "logs/audit.db", flushIntervalMs: 250, maxBatch: 200 });

AuditLogger.getInstance().flush(); // força a gravação (shutdown, teste)
AuditLogger.getInstance().close(); // descarrega e fecha
```

O `log()` recebe a entrada de uma REQUISIÇÃO (`method` e `url` obrigatórios, mais `action`,
`statusCode`, `durationMs`, `requestBody`, `requestParams`, `requestQuery`, `responseBody`,
`entity`, `exercicio`, `userId`, `username`, `requestId`). Não é o `AuditEntry` do `@Auditable`
(`entity` em texto, `entityId`, `before`, `after`...), então ele não entra direto no
`setAuditStorage`. Para gravar a auditoria do `@Auditable` no mesmo SQLite, adapte os campos:

```ts
import { AuditLogger, setAuditStorage } from "@mateusseiboth/ts-decorators";

setAuditStorage(async (entry) => {
  AuditLogger.getInstance().log({
    method: entry.method, // "OrderController.update"
    url: `${entry.entity}/${entry.entityId ?? ""}`,
    action: entry.action,
    requestBody: entry.before,
    responseBody: entry.after,
    entity: entry.entidade,
    userId: entry.userId,
  });
});
```

| Opção             | Default               | Efeito                                  |
| ----------------- | --------------------- | --------------------------------------- |
| `path`            | `<cwd>/logs/audit.db` | Arquivo SQLite                          |
| `flushIntervalMs` | `250`                 | Janela de agrupamento das escritas      |
| `maxBatch`        | `200`                 | Quantidade que força um flush imediato  |
| `maxTextBytes`    | `200_000`             | Teto por campo TEXT; acima disso, resumo |
| `rotate`          | `"monthly"`           | Um arquivo por mês (`audit-2026-11.db`), por dia (`"daily"`) ou um só (`"none"`) |
| `retention`       | `12` mensal, `90` diário | Períodos guardados, contando o atual; `Infinity` nunca apaga |
| `skipResponseBody`| `[]`                  | Verbos sem corpo de resposta gravado, ex.: `["GET"]` |
| `sensitiveKeys`   | `[]`                  | Chaves mascaradas além das padrão, ex.: `["cpf"]` |

**Máscara.** Em `requestBody` e `responseBody`, em qualquer nível, o valor de `senha`,
`password`, `token`, `secret`, `access_token`, `refresh_token`, `inviteUrl`, `authorization` e
`cookie` vira `***`, sem diferenciar maiúsculas, assim como o de campo `@Field({ encrypted: true })`.

**Rotação.** Cada entrada vai para o arquivo do período em que foi registrada. O `audit.db` único
de antes continua legível e só sai quando a última escrita dele passa da retenção. Quem lê a
auditoria usa `AuditLogger.getInstance().listFiles()` (do mais antigo para o mais novo).

**Auditoria de leitura.** `@Auditable({ read: true })` (ou a lista dos métodos) registra quem
consultou o registro, sem gravar o conteúdo lido; a listagem registra o filtro usado. A leitura é
gravada em lote, fora da transação da requisição: chame `flushAuditReads` num `onShutdown`.

O buffer é descarregado em `beforeExit`/`exit`, então derrubar o processo não
perde o que estava na fila.

Nada do que chega no `log()` pode derrubar a request:

- **`BigInt`** vira string (o `JSON.stringify` estoura com BigInt cru, e
  `id`/`sequencial` do Prisma chegam assim o tempo todo).
- **Referência circular / getter que lança** vira
  `{_unserializable: true, reason}` em vez de exceção.
- **Corpo gigante** (uma listagem de 15 mil linhas passa fácil dos 200 KB, e o
  SQLite recusa com `SQLITE_TOOBIG`) vira
  `{_truncated: true, bytes, preview}` com os primeiros 2 KB.
- O `id` é **UUIDv7**: ordenável no tempo, então as inserções caem no fim do índice
  da chave primária em vez de espalhadas pela árvore, como aconteceria com v4.
- Campos sensíveis mascarados em qualquer profundidade: `senha`, `password`,
  `token`, `secret`, `access_token`, `refresh_token`, `inviteUrl`.

Máscara e BigInt são resolvidos **dentro** do `JSON.stringify`, numa passada só.
A versão anterior reconstruía a árvore inteira antes de serializar — e
`Object.fromEntries(Object.entries(x))` **esvazia** todo objeto sem propriedade
própria: `Date` virava `{}` no log, assim como qualquer classe com `toJSON()`.

---

## Report Engine

`engine.health()` devolve `{ queue, worker }`, com o estado do worker (Chrome): `alive`,
`inFlight`, `restarts`, `completed`, `failed` e os instantes do último sucesso e da última falha.
`worker` é `null` enquanto ele não subiu.

Engine completa de relatórios em segundo plano: fila durável em **SQLite próprio**
(plugar nunca exige migration no banco do app), worker persistente com **Chromium
quente** (Playwright + Handlebars, rodando de dentro de `node_modules`), geração em
lotes por peso, merge via `pdfunite`, progresso via notifier plugável e **formatos
de saída por Strategy** (PDF e JSON inclusos; XLSX e outros registráveis).

Fluxo de um relatório:

```text
POST /forge/:id → loadDefinition (app resolve o modelo) → engine.enqueue (SQLite)
  → processor: runInContext → resolveDataSource(model_tag).report(...) → posProcess
  → provideHeader/provideAssinaturas → Strategy do formato
      pdf  → worker persistente (Chromium quente) → HTML da view → PDF em lotes → pdfunite
      json → main.ts/buildReportData → arquivo .json (viewModel TRATADO)
  → hooks (background_jobs) + notifier (WebSocket) → GET /download/:id
```

### Adicionando em um projeto (passo a passo)

**1. Dependências** (peer deps opcionais — só quem gera PDF precisa):

```bash
bun add github:mateusseiboth/ts-decorators playwright handlebars pdf-lib
npx playwright install chromium
# pdfunite (merge multi-parte) é pacote do SISTEMA, não do npm:
sudo dnf install poppler-utils   # Fedora — apt install poppler-utils em Debian/Ubuntu
```

O `pdf-lib` escreve a numeração contínua ("Página X de Y") nas partes do relatório gerado em
lotes, antes do merge.

**2. Boot** — crie `src/bootstrap/reportEngine.ts` e chame no `src/index.ts`
(depois dos setters de `setPrismaClient`/`setHandlerContext`):

```ts
import path from "node:path";
import {
  addCompanyIdToTransaction, configureReportEngine, getDAO, getReportStatusMessage,
  type ReportEngine,
} from "@mateusseiboth/ts-decorators";
import prismaClient from "@database/prisma";
import {store} from "@middlewares/context";

export function initializeReportEngine(): ReportEngine {
  return configureReportEngine({
    // OBRIGATÓRIOS ------------------------------------------------------------
    viewsRoot: path.join(process.cwd(), "src", "views", "reports"),
    resolveDataSource: (modelTag) => ({
      // A fonte é dona da própria tx/RLS (service @Transaction ou DAO + init(tx)):
      report: (filters, reportTag, entidade, exercicio) =>
        prismaClient.$transaction(async (tx) => {
          await addCompanyIdToTransaction(tx, String(entidade));
          const dao = new (getDAO(Number(modelTag)) as any)();
          dao.init(tx);
          return dao.report(filters, reportTag, entidade, exercicio);
        }),
    }),

    // RECOMENDADOS ------------------------------------------------------------
    // Reidrata o AsyncLocalStorage do app fora do ciclo HTTP:
    runInContext: (job, fn) =>
      store.run({requestId: job.id, user: job.user, entity: Number(job.user.entidade),
                 exercicio: job.exercicio, transaction: {} as any} as any, fn),
    // Notificações: implemente ReportNotifier com o transporte do app (WebSocket, SSE...):
    notifier: {
      notifyStatus: (item) => socket.sendTo(item.user.id, {id: item.id, status: item.status,
                                                          message: getReportStatusMessage(item)}),
      notifyProgress: (job, progress) => socket.sendTo(job.user.id, {id: job.id, progress}),
    },
    // Cabeçalho (brasão) e assinaturas — queries do app:
    provideHeader: async (job) => ({brasaoURL: "https://..."}),
    provideAssinaturas: async (job) => [{name: "Fulano", role: "Contador"}],
    // Sync opcional com as tabelas do app:
    hooks: {
      onStarted:   (job) => criarBackgroundJob(job),
      onCompleted: (job, result) => atualizarBackgroundJob(job.id, "COMPLETED", result),
      onFailed:    (job, erro) => atualizarBackgroundJob(job.id, "ERROR", {erro}),
    },

    // AJUSTES FINOS (todos com default) ---------------------------------------
    // resolveView: normaliza o view_path do banco → caminho RELATIVO ao viewsRoot,
    // SEM sufixo /render (ex.: "@views/reports/carne" → "carne"). Recebe o job —
    // dá para variar o layout por CNPJ/config da entidade:
    resolveView: (viewPath, job) => viewPath.replace(/^@views\/reports\//, ""),
    // partialsDir: onde vivem header.hbs/footer.hbs/assinaturas.hbs
    // (default: <viewsRoot>/partials — ajuste se os seus estiverem em outro lugar):
    partialsDir: path.join(process.cwd(), "src", "views", "reports", "partials"),
    // outputDir ("report/"), queueDbPath ("data/report_queue.db"), queueName,
    // concurrency (REPORT_CONCURRENCY), pollMs, retentionMs (24h),
    // viewSetupModule (helpers Handlebars custom: exporta registerReportHelpers(hbs)),
    // formats (strategies extras), templateStore, warmupWorker, enqueueStatusCode (203).
  });
}
```

No `index.ts`: `const engine = initializeReportEngine();` e, no SIGTERM/drain,
`await engine.shutdown()` (encerra o worker/Chrome e fecha o SQLite). A fila de
relatórios é uma fila do registry genérico: `pauseProcessors()`/`getInFlightCount()`
já a incluem no drain de deploy.

**3. Rotas** — monte o router da engine ATRÁS dos SEUS middlewares de auth:

```ts
import {createReportRouter} from "@mateusseiboth/ts-decorators";

router.use(authMiddleware, createReportRouter({
  // Carrega a definição da SUA tabela reports (e resolve o modelo da entidade):
  loadDefinition: async (id, req) => carregarDefinicao(id),
  buildUser: (req) => ({id: userInfo.id, username: userInfo.nome, entidade: userInfo.entidade}),
  resolveExercicio: (req) => Number(req.headers.exercicio) || new Date().getFullYear(),
  // Opcional: mapeia a view canônica para o shape que o SEU frontend espera:
  mapQueueView: (view) => ({id: view.id, username: view.user.username, ...}),
  // enqueueStatusCode: 203 (default) | 202 · deleteAfterDownload: true (default)
}));
```

Rotas montadas:

| Rota | Descrição |
| ---- | --------- |
| `POST /forge/:id` | Enfileira (`?format=json` para JSON). Responde `{message, data: {id, position, queueSize, status}}` |
| `GET /queue/status/:id` | Status/posição do job (polling) |
| `GET /queue/user` | Jobs do usuário logado |
| `GET /download/:id` | Arquivo gerado (Content-Type pelo formato; apaga após o download) |
| `POST /data/:id` | **Síncrona**: viewModel TRATADO direto na resposta (Studio/integrações — filtre em relatórios grandes) |
| `POST /templates/:reportId` · `GET /templates/:reportId` · `PUT .../active/:templateId` · `DELETE .../active` | Templates do Studio (TemplateStore) |

Para enfileirar de OUTRO controller (sem HTTP do router):
`await getReportEngine().enqueue({definition, filters, exercicio, user})`.

### Contrato das views

Cada relatório é uma pasta em `viewsRoot/<view_path>/` com três arquivos:

```text
src/views/reports/meu-relatorio/
  main.ts       → buildReportData(...)  — transformação PURA (obrigatória)
  render.ts     → buildReportHTML(...)  — HTML p/ PDF (consome buildReportData)
  template.hbs  → Handlebars (helpers default: {{currency v}}, {{dateNow}})
```

```ts
// main.ts — o MESMO viewModel alimenta o template E a saída JSON (sem fallback:
// view sem buildReportData falha o job de format=json com erro claro).
export function buildReportData({rows, filters, title, exercicio, orderByFunction}) {
  const items = Array.isArray(rows) ? rows : rows?.data || [];
  return {title, filters, items: items.map(normalize), total: items.length};
}
```

```ts
// render.ts
import {readFileSync} from "fs";
import Handlebars from "handlebars";
import {buildReportData} from "./main";

export async function buildReportHTML({rows, header, title, filters, orderByFunction, assinaturas, templateSource}) {
  const viewModel = {...buildReportData({rows, filters, title, orderByFunction}),
                     header, ano: new Date().getFullYear(), assinaturas};
  // templateSource = template ativo do Studio (TemplateStore); senão o arquivo local:
  const source = templateSource ?? readFileSync(`${__dirname}/template.hbs`, "utf-8");
  return {html: Handlebars.compile(source)(viewModel)};
}

// A divisão em lotes é AUTOMÁTICA: passou do peso máximo, o worker fatia por peso e mescla com
// pdfunite. Os exports abaixo só ajustam o corte.
// export const SUPPORTS_BATCHING = false;         // opt-out: força passada única (relatório com
//                                                 // total geral entre linhas, que em partes sairia parcial)
export const BATCH_MAX_WEIGHT = 400;               // peso máximo por parte (padrão 400)
export const getBatchWeight = (row) => 1 + (row.parcelas?.length ?? 0);
export const EXTERNALIZE_HEADER_IMAGE = true;       // brasão por arquivo (1 capa/registro)
// buildReportHTML pode devolver {html, disableHeaderFooter: true} p/ layouts sem cabeçalho
```

Os partials `header.hbs`, `footer.hbs` e `assinaturas.hbs` vêm de `partialsDir` e
viram o cabeçalho/rodapé do `page.pdf()` (margens 130px/70px). `header.brasaoURL`
é baixado, comprimido pelo `Bun.Image` (Bun >= 1.4; WebP, sem aumentar) e injetado como
`header.brasaoBase64`. SVG não é aceito: o relatório sai sem o brasão.

### Formatos de saída (Strategy)

`pdf` e `json` vêm registrados. Formato novo = uma Strategy (sem if/else):

```ts
import {loadReportViewModel, registerOutputFormat} from "@mateusseiboth/ts-decorators";

registerOutputFormat({
  format: "xlsx",
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  fileExtension: "xlsx",
  async generate(ctx) {
    // Mesmo viewModel tratado do PDF/JSON:
    const viewModel = await loadReportViewModel({viewDir: ctx.viewDir, rows: ctx.data,
      filters: ctx.job.filters, title: ctx.job.definition.title, exercicio: ctx.job.exercicio});
    // ... gera a planilha em `${ctx.outputDir}/${ctx.job.id}.xlsx` ...
    return {file: `${ctx.job.id}.xlsx`, contentType: this.contentType, parts: 1, bytes, durationMs};
  },
});
```

O cliente escolhe com `POST /forge/:id?format=xlsx`; o `GET /download/:id` já
responde com o Content-Type/extensão certos.

### Modelos por entidade e templates

Dois mecanismos complementares, ambos SEM tocar o pacote:

- **Modelos (linhas da tabela `reports` do app)**: o mesmo relatório
  (tag + model_tag) pode ter uma linha GLOBAL (convenção: entidade 79, todos veem)
  e linhas específicas por entidade, cada uma com seu `view_path`. A resolução
  (configuração da entidade → linha da entidade → global) é feita pelo
  `loadDefinition` do app — o forge sempre gera o modelo que a entidade configurou.
- **Templates (TemplateStore)**: conteúdo HBS salvo pela API `/templates`
  (ex.: exportado pelo [Studio](#studio-cli)) e ativado por relatório. Quando há
  template ativo, o worker entrega o conteúdo em `templateSource` para o
  `buildReportHTML` usar no lugar do `template.hbs` local. Default:
  `SqliteTemplateStore` no MESMO SQLite da engine (sem migration); substituível
  via `templateStore` na config.

### Envs e troubleshooting

| Env | Default | Descrição |
| --- | ------- | --------- |
| `REPORT_CONCURRENCY` | `1` | Relatórios simultâneos (fila E worker/Chrome) |
| `REPORT_BATCH_MAX_WEIGHT` / `REPORT_BATCH_SIZE` | `400` | Peso máximo por parte (override do valor da view) |
| `REPORT_STREAM_PAGES` | ligado | `false` desliga a gravação das linhas em arquivos de página no disco (um por parte) nos relatórios gerados em lotes |
| `REPORT_PAGE_NUMBER_SIZE` / `REPORT_PAGE_NUMBER_Y` / `REPORT_PAGE_NUMBER_RIGHT_PAD` | `6.75` / `22` / `20` | Tamanho da fonte, distância da base e recuo à direita (em pontos do PDF) da numeração contínua nos relatórios em lotes |
| `REPORT_PAGE_TIMEOUT_MS` | `300000` | Timeout de load/render por página |
| `REPORT_HEADER_IMAGE_TIMEOUT_MS` / `_MAX_BYTES` / `_MAX_WIDTH` / `_MAX_HEIGHT` / `_MAX_PIXELS` / `_QUALITY` | — | Limites do brasão |
| `REPORT_TEMP_MAX_AGE_MS` | `3600000` | Idade máxima de temporários órfãos (limpeza no boot) |
| `REPORT_PDF_MERGE_BIN` | `pdfunite` | Binário de merge (poppler-utils) |
| `ENABLE_FIREFOX_REPORT` | — | `1` usa Firefox em vez de Chromium |

Problemas comuns:

- **`Cannot find module .../render.ts`** → o `view_path` do banco não é relativo ao
  `viewsRoot`. Configure `resolveView` (strip de alias/prefixo/`.js`/`/render`).
- **PDF sai SEM header/footer** → `partialsDir` errado (partials não encontrados
  compilam vazios). Aponte para a pasta real dos seus `header.hbs`/`footer.hbs`.
- **`JSON.stringify cannot serialize BigInt`** → resolvido pela engine no
  `enqueue` (converte BigInt/Date). Se ocorrer na fase do WORKER, o `report()` do
  seu DAO devolveu BigInt cru — envolva o retorno em `convertBigIntValues`.
- **`Formato de relatório desconhecido`** → o formato pedido não tem Strategy
  registrada (o erro sai NO forge, não na fila).
- **Worker não sobe no CI/teste** → use `warmupWorker: false` (JSON continua
  funcionando; o Chrome sobe sob demanda no primeiro PDF).

---

## Studio (CLI)

```bash
bunx ts-decorators studio [--port 4123]
```

Abre um editor local de templates HBS com **preview em tempo real** alimentado pelos
dados TRATADOS do app: informe a URL da rota `POST .../data/:reportId`, os headers de
auth e os filtros — o preview renderiza com os mesmos helpers do worker. O botão
**Exportar** publica o template no sistema (`POST .../templates/:reportId`); a escolha
do template ativo por relatório é feita via `PUT .../templates/:reportId/active/:templateId`.

---

## Plugin do oxlint — `ts-decorators/no-enum`

`@mateusseiboth/ts-decorators/oxlint` é um plugin JS do oxlint (formato de plugin do ESLint, sem
dependências) com a regra `ts-decorators/no-enum`: TypeScript sem `enum`, `const enum` nem
`declare enum`. Tabela de domínio é objeto `as const` + tipo de mesmo nome. O id da regra é o
mesmo de antes, então a `.oxlintrc.json` existente só troca o `specifier`:

```json
{
  "jsPlugins": [{ "name": "ts-decorators", "specifier": "@mateusseiboth/ts-decorators/oxlint" }],
  "rules": { "ts-decorators/no-enum": "error" }
}
```

```ts
// recusado:
enum Situacao { ATIVO, INATIVO }
// aceito:
export const Situacao = { ATIVO: "A", INATIVO: "I" } as const;
export type Situacao = (typeof Situacao)[keyof typeof Situacao];
```

---

## Migrando da 1.x

A 2.0 junta a linha 1.x deste pacote com a base comum que ganhou suporte ao Prisma 8. Um projeto no
Prisma 7 continua funcionando sem mudar o bootstrap (`setPrismaClient`, `setHandlerContext`,
`RegistryRouter`, `GlobalRouter`, `AllRouters`, `@Rest`, `@Get`...). O que muda de comportamento:

| O quê | 1.x | 2.0 |
| ----- | --- | --- |
| Tenant padrão (`defaultCompanyIdInjector`) | `SET LOCAL "my.company_id" = ${Number(id)}` | `SELECT set_config('my.company_id', $1, true)` com o id **como parâmetro e como texto**: UUID passa intacto, id numérico grava o mesmo `"42"`. Prisma 8 incluso |
| `getWhere` com valor inválido | `1,5` virava 15, `abc` virava 0 | responde **400** `{ message, errors: [{ path, message }] }` |
| `getWhere` com intervalo numérico (`?codigo=1-5`) | um `equals` por número | `{ gte: 1, lte: 5 }` numa condição só |
| Operadores `greaterThanOrEqual`, `lessThanOrEqual`, `notIn`, `notInRange`, `notNull`, `containing` | viravam igualdade | filtram o que o nome diz |
| Filtro por data | dia lido em UTC | o dia informado no fuso do processo; `parseDate("2026-01-15")` é meia-noite local |
| `@Cacheable`, `@Auditable`, `@TransactionalClass` | só métodos declarados na própria classe | também os herdados do controller base |
| `RouteBuilder.withPrismaOptions` | `getOrderBy` + `getWhere` + `getPaginate` | + `getColumns` (`?fields=`) |
| `getOrderBy` | só campo direto | aceita `relacao.campo` (to-one); caminho por to-many é descartado |
| `folderRouter` / `@GlobalRouter` / `@RegistryRouter` | banner com `console.log` por rota | `logger.debug` por rota e UMA tabela em `logger.info`; `AllRouters` ganhou `endpoints` |
| `SqliteQueueAdapter` | tabela sem `lockedAt` | coluna `lockedAt` criada sozinha (`ALTER TABLE`) e job preso volta para a fila |
| `convertBigIntValues` | `bigint` e `Date` | também `Temporal` (vira ISO) |
| Prefixo dos logs | `[@mateusseiboth/ts-commons]` | `[@mateusseiboth/ts-decorators]` |
| `setPrismaClient` | só client com `$transaction` | aceita também a fachada do Prisma 8 (`transaction`) |

Variável de log: continua `TS_COMMONS_LOG_LEVEL`.

---

## Utility Functions

### `makePrismaOptions`

Merges `res.locals.where`, `res.locals.orderBy`, `res.locals.paginate` and `res.locals.columns` into a single object ready to spread into any Prisma `findMany` call.

```ts
import {makePrismaOptions} from "@mateusseiboth/ts-decorators";

// Typically used after getWhere + getOrderBy + getPaginate + getColumns middlewares have run
const options = makePrismaOptions(res);
// → { where: { ...where, AND: [...] }, orderBy: [...], skip: 20, take: 10 }

const records = await prisma.street.findMany(options);
```

> **ℹ️** `where` always has `AND: []` even when empty, so you can safely push extra conditions into it without null-checking.

> **⚠️** A chave `columns` (projeção do [`getColumns`](#getcolumns)) só aparece quando o cliente
> mandou `?fields=`, e **não é uma chave do Prisma** — quem consome é o `executePrismaQuery`,
> que a remove antes da query. Se o seu DAO passa `options` direto para o `findMany`, aplique
> a projeção com `applyColumnProjection(options)` antes.

### `removeFromWhere`

Removes a specific field key from inside `AND`/`OR` conditions in a Prisma where object. Useful when you need to programmatically strip a filter after it has been built.

```ts
import {removeFromWhere} from "@mateusseiboth/ts-decorators";

const options = makePrismaOptions(res);
// options.where = { AND: [{ OR: [{ enabled: true }] }] }

removeFromWhere(options, "enabled");
// options.where = { AND: [{ OR: [] }] }
```

### `executePrismaQuery`

Two-step pagination helper: first fetches matching IDs, then fetches full rows (with includes) for those IDs. Returns a normalised paginated response.

```ts
import {executePrismaQuery} from "@mateusseiboth/ts-decorators";

const result = await executePrismaQuery(prisma.product, options);
// 48 matching rows, take: 10, page: 2 →
// {
//   data: {
//     data: Product[],
//     paginacao: { totalPage: 48, page: 2, total: 5 }
//   }
// }
```

> **⚠️** The names are historical: `totalPage` is the **number of matching records** (the `count`) and `total` is the **number of pages** (`Math.ceil(count / take)`).

#### Tipos do domínio: `reviveDates` e `mapRow`

O padrão serializa para JSON: `bigint` e datas viram texto. Para usar a listagem no código (e não
só devolver para a tela), `reviveDates: true` mantém as datas como `Date` (o `Temporal` vira
`Date`), e `mapRow(row)` monta o tipo do domínio de cada linha. Valem no `executePrismaQuery` e no
`executeOrmQuery`.

#### Quantas consultas isso custa

A busca das PKs é separada de propósito: ela percorre o índice sem carregar coluna nenhuma, e
é o que deixa a paginação barata numa tabela grande.

**Por padrão são 3 consultas em sequência**: PKs, linhas e `count`. As duas economias abaixo são
opt-in, porque mudam o que vai ao banco.

| Situação | Consultas |
| --- | --- |
| Nenhum registro bate com o filtro | **1** (só as PKs), sempre |
| Padrão (sem `deriveTotal` nem `countTtlMs`) | **3** em sequência (PKs, linhas, `count`) |
| `deriveTotal`: a página veio incompleta, ou não há `take` | **2** (PKs + linhas), o total é deduzido |
| `deriveTotal` ou `countTtlMs`: total ainda desconhecido | **2 idas** (PKs, depois linhas **e** `count` juntos) |
| `countTtlMs`: total memorizado | **2** (PKs + linhas) |

- **Total deduzido (`deriveTotal: true`).** Se a página trouxe menos linhas que o `take`, ela é a
  última: o total é `skip + linhas`. Exato, sem consulta. Vale para toda listagem que cabe numa
  página só e para a última página de qualquer listagem.
- **`count` junto das linhas.** Com `deriveTotal` ou `countTtlMs` ligado, quando a contagem é
  mesmo necessária ela sai no mesmo passo da busca das linhas em vez de esperar por ela.

```ts
import {executePrismaQuery, setDeriveTotalDefault} from "@mateusseiboth/ts-decorators";

// por chamada
await executePrismaQuery(prisma.product, {...makePrismaOptions(res), deriveTotal: true});

// ou uma vez, no bootstrap, para o processo inteiro (padrão: false)
setDeriveTotalDefault(true);
```

#### `countTtlMs` — reaproveitar o total entre páginas

Numa tabela de 28 mil linhas o `count` é **~8 ms dos ~11 ms** da listagem: sozinho,
a consulta mais cara das três. E o total não muda enquanto o usuário folheia as
páginas — o filtro é o mesmo.

```ts
const result = await executePrismaQuery(this.tx.contribuinte, {
  ...makePrismaOptions(res),
  countTtlMs: 30_000, // a página 2 em diante reaproveita o total da página 1
});
```

Medido num sistema em produção (banco real, página 2 de cada listagem):

| Model | 3 consultas | 2 consultas | 2 + `countTtlMs` |
| --- | ---: | ---: | ---: |
| `contribuinte` (28.638 linhas) | 11,3 ms | 9,2 ms | **2,1 ms** (−81%) |
| `rua` (10.581) | 12,3 ms | 12,7 ms | **1,6 ms** (−87%) |
| `bairro` (3.499) | 5,3 ms | 5,2 ms | **1,4 ms** (−73%) |
| `imovelUrbano` (14.896) | 18,4 ms | 16,4 ms | **10,4 ms** (−44%) |

> **É opt-in, e o preço é um total possivelmente desatualizado** por até `countTtlMs`.
> Ele alimenta o contador de páginas, não uma decisão de negócio — mas se a sua tela
> precisa do número exato ao vivo, não ligue.

A chave inclui **sempre a entidade**, tirada do contexto da request: a RLS filtra por
ela no banco sem aparecer no `where`, e sem isso o total de um município seria servido
a outro. Model e filtro também entram na chave.

Depois de uma escrita que muda o total, derrube o que está memorizado:

```ts
import {invalidateCountCache} from "@mateusseiboth/ts-decorators";

invalidateCountCache("Contribuinte"); // só esse model
invalidateCountCache();               // todos
```

Antes de consultar, aplica a projeção do [`getColumns`](#getcolumns) (`options.columns`, vinda
do `makePrismaOptions`): ela vira `select` — descartando o `include`, já que o Prisma aceita
select XOR include — e, quando o DAO tem `select` próprio, o resultado é a **interseção**
(a projeção do cliente só estreita, nunca amplia o que a rota expõe).

### `applyColumnProjection`

Aplica a projeção `options.columns` em um objeto de options e remove a chave — é o que o
`executePrismaQuery` chama internamente. Use direto nos DAOs que montam a query à mão
(`findMany`, `findFirst`) e ainda assim querem respeitar `?fields=`.

```ts
import {applyColumnProjection} from "@mateusseiboth/ts-decorators";

const options = makePrismaOptions(res); // pode conter { columns: {...} }
options.select = {id: true, name: true, cpf: true}; // whitelist do DAO

applyColumnProjection(options);
// ?fields=id,name → options.select = { id: true, name: true }, sem a chave columns

const rows = await this.tx.pessoa.findMany(options);
```

### `collectFieldTypes`

Returns a flat `Record<fieldPath, typeName>` for all `@Field()`-decorated properties of a model, **including nested models** (prefixed with dot-notation).

> **⚠️ Required dependencies:**
>
> - The instance's class MUST have `@InitFields` — without it, `getFieldTypes` returns `{}` and `collectFieldTypes` returns an empty object
> - Only fields with `@Field()` are included — other properties are invisible
> - For nested fields, the nested model's class MUST also have `@InitFields` + `@Field()` on its properties, otherwise the nested branch returns nothing
> - For nested fields, the relation column MUST have `@NestedModel(RelatedModel)` in addition to `@Field()`

```ts
import {collectFieldTypes} from "@mateusseiboth/ts-decorators";

// StreetModel has @InitFields, @Field on id/name, and @Field + @NestedModel on district
// DistrictModel has @InitFields and @Field on id/name
collectFieldTypes(new StreetModel());
// → {
//     "id": "string",
//     "name": "string",
//     "district": "any",      ← the relation field itself
//     "district.id": "string",
//     "district.name": "string",
//   }

// ❌ Without @InitFields on StreetModel:
collectFieldTypes(new StreetModel()); // → {}

// ❌ Without @InitFields on DistrictModel:
collectFieldTypes(new StreetModel());
// → { "id": "string", "name": "string", "district": "any" }
//   nested district fields are missing
```

> **Memoizado e congelado.** O resultado sem prefixo é guardado por classe e
> devolvido por referência — não altere o objeto, copie antes
> (`{...collectFieldTypes(Model.prototype)}`). Um registro novo de `@Field` /
> `@NestedModel` invalida o cache sozinho; `clearMetadataCache()` força a
> recontagem. Passar o **prototype** (`StreetModel.prototype`) é o caminho
> rápido: a travessia não instancia mais nada. Veja
> [Performance & logging](#performance--logging).

### Other helpers

| Function                            | Description                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `jwtDecode(token)`                  | Decodes (no signature verification) a JWT payload from a base64 string                    |
| `filterObjectByModel(obj, Model)`   | Strips keys from `obj` that are not registered `@Field()` properties of Model             |
| `extractAndRemoveByKey(obj, key)`   | Recursively removes **every** occurrence of `key` (mutating `obj`) and returns `{ value, obj }`, where `value` is the last occurrence visited |
| `convertBigIntValues(data)`         | Recursively converts `BigInt`, `Date` and `Temporal` values to strings (safe for `JSON.stringify`) — including `BigInt` inside plain arrays |
| `addCompanyIdToTransaction(tx, id, injector?)` | Applies the tenant with the configured strategy (default `SELECT set_config('my.company_id', $1, true)`, id as a text parameter, Prisma 7 and 8) |
| `publishRequestValue(res, key, value)` | Writes into `res.locals` and, when configured, into the request context |

---

## Running tests

```bash
bun test
```

---

## Portão de saída (format, lint, typecheck, tests)

Formatting is handled by **oxfmt**, linting by **oxlint** (type-aware, backed by `oxlint-tsgolint`
on the TypeScript 7 compiler). There is no ESLint and no Prettier here — and no reason to add them.

```bash
bun run format        # oxfmt: writes the formatting
bun run format:check  # oxfmt: fails if anything is unformatted
bun run lint          # oxlint --type-aware
bun run lint:fix      # oxlint --type-aware --fix
bun run typecheck     # tsc --noEmit
bun test
```

Run them in that order before finishing any change — all four must pass. The configuration lives in
`.oxfmtrc.json` and `.oxlintrc.json`; `tsconfig.json` typechecks `src` and `index.ts` with the Bun types.

> **ℹ️ Optional peers in devDependencies:** `pdf-lib` and `playwright` are OPTIONAL peer
> dependencies of the published package, but they are installed for development so the report worker
> typechecks. Tests must never depend on whether they happen to be installed. Image compression uses
> only `Bun.Image` (see `tests/report.image.test.ts`).

---

## Contributing

Contributions are welcome. Please follow the guidelines below to keep things consistent.

### Setup

```bash
bun install
```

### Running tests

```bash
bun test
```

All changes must pass the existing test suite. New features must include tests.

### Guidelines

- **One concern per decorator/function.** Keep decorators focused on a single responsibility.
- **Modo legado.** O pacote usa `experimentalDecorators` + `emitDecoratorMetadata`; decorator novo é escrito para o legado, sem versão TC39 e sem aviso de modo.
- **Do not add runtime dependencies.** Only the `./observability` subpath depends on the OpenTelemetry SDK; the main entry point loads `@opentelemetry/api` lazily, as an optional peer.
- **Tests use `bun test`.** Place test files in `tests/` with the `.test.ts` suffix. Reuse the mock helpers in `tests/_helpers.ts` and the model fixtures in `tests/_models.ts`.
- **Do not break the metadata WeakMap contract.** `@InitFields` is the initialiser for the `CLASS_FIELDS` WeakMap — never read from `getFieldTypes` in a decorator that runs before `@InitFields`.

### Adding a new decorator

1. Create `src/decorators/myDecorator.ts`
2. Implement it for the legacy mode (`experimentalDecorators`)
3. Export it from `index.ts`
4. Add tests in `tests/myDecorator.test.ts`
5. Document it in this README under the [Decorators](#decorators) section
