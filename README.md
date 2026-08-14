# @mateusseiboth/ts-decorators

A collection of **TypeScript decorators**, **Express middlewares**, and **utility functions** for building REST APIs with Bun, Express and Prisma — less boilerplate, more joy.

## Install

```bash
bun add @mateusseiboth/ts-decorators
```

### Peer dependencies

```bash
bun add typescript reflect-metadata express @types/express zod
```

### tsconfig.json

**Legacy decorators (recommended):**

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

@AutoConvert      → uses getFieldTypes(this) to coerce incoming values
                    (the class or its model MUST have @InitFields + @Field)

collectFieldTypes → uses getFieldTypes + getNestedModel recursively
                    (ALL classes involved MUST have @InitFields)
```

> **Golden rule:** if a field does not have `@Field()`, it does not exist for the system. Without `@InitFields` on the class, no fields are found — no error is thrown, the result is simply empty/ignored.

---

## Table of Contents

- [How it all fits together](#how-it-all-fits-together)
- [Middlewares](#middlewares)
  - [getWhere](#getwhere)
  - [getOrderBy](#getorderby)
  - [getPaginate](#getpaginate)
- [Decorators](#decorators)
  - [@Field / @InitFields](#field--initfields) ← **read this first**
  - [@ModelTagged / @DAOFor](#modeltagged--daofor)
  - [@NestedModel](#nestedmodel)
  - [@AutoConvert](#autoconvert)
  - [@Cacheable / @CacheMethod](#cacheable--cachemethod)
  - [@RateLimit / @RateLimitMethod](#ratelimit--ratelimitmethod)
  - [@Auditable](#auditable)
  - [@logDecorator](#logdecorator)
  - [@Transactional / @TransactionalClass](#transactional--transactionalclass)
  - [@Validate / @WithValidation](#validate--withvalidation)
  - [@Singleton / @Scoped / @Transient](#lifecycle--di--singleton--scoped--transient)
  - [@MaskSensitive / applyMask](#masksensitive--applymask)
  - [@RequiresRole](#requiresrole)
  - [@Emit / @Listen + eventBus](#emit--listen--eventbus)
  - [@Mutex / @Semaphore](#mutex--semaphore)
  - [@Cron](#cron)
  - [@Queue / @Processor + adapters](#queue--processor--adapters)
- [HTTP Routing](#http-routing)
  - [RouteBuilder](#routebuilder)
  - [@Get / @Post / @Put / ... (rotas estilo NestJS)](#get--post--put---rotas-estilo-nestjs)
  - [@Rest — CRUD declarativo](#rest--crud-declarativo)
  - [Ligando tudo no BaseRegistry](#ligando-tudo-no-baseregistry)
- [Utility Functions](#utility-functions)
- [Contributing](#contributing)

---

## Middlewares

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

| Query syntax                 | Prisma equivalent                            |
| ---------------------------- | -------------------------------------------- |
| `?name=John`                 | `{ name: { equals: "John" } }`               |
| `?name=contains:oh`          | `{ name: { contains: "oh" } }`               |
| `?name=startsWith:Jo`        | `{ name: { startsWith: "Jo" } }`             |
| `?name=endsWith:hn`          | `{ name: { endsWith: "hn" } }`               |
| `?status=in:1,2,3`           | `{ status: { in: [1, 2, 3] } }`              |
| `?age=inRange:18-65`         | `{ age: { gte: 18, lte: 65 } }`              |
| `?age=greaterThan:18`        | `{ age: { gt: 18 } }`                        |
| `?age=lessThan:30`           | `{ age: { lt: 30 } }`                        |
| `?age=greaterThanOrEqual:18` | `{ age: { gte: 18 } }`                       |
| `?age=lessThanOrEqual:30`    | `{ age: { lte: 30 } }`                       |
| `?field=isNull:`             | `{ field: null }`                            |
| `?field=notNull:`            | `{ field: { not: null } }`                   |
| `?id=1;2;3`                  | `OR: [{ id: 1 }, { id: 2 }, { id: 3 }]`      |
| `?name=!John`                | `NOT: [{ name: "John" }]`                    |
| `?id=5-10` (numeric field)   | `OR: [{ id: 5 }, ..., { id: 10 }]` (expands) |
| `?district.name=Downtown`    | `{ district: { name: "Downtown" } }`         |

> **ℹ️ Type coercion:** query values are automatically cast to the field's type as registered via `@Field()`. If the field is `"number"`, the string `"5"` becomes `5`.

**Programmatic version** (without Express):

```ts
import {buildWhereFromQuery} from "@mateusseiboth/ts-decorators";

// Takes the query object and a MODEL INSTANCE
const where = buildWhereFromQuery(req.query, new StreetModel());
```

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

> **ℹ️** If the `paginate` header is not `"true"`, `res.locals.paginate` stays `undefined` and `makePrismaOptions` omits `skip`/`take` from the Prisma query (returns all records).

---

## Decorators

### `@Field` / `@InitFields`

The foundation of the entire metadata system. Every other feature that needs to know your model's field names or types depends on these two decorators.

> **⚠️ `@InitFields` MUST be applied to every model class. `@Field()` MUST decorate every property that should be visible to `getWhere`, `getOrderBy`, `@AutoConvert`, and `collectFieldTypes`. Fields without `@Field()` are completely invisible to the system.**

```ts
import {Field, InitFields} from "@mateusseiboth/ts-decorators";

@InitFields // REQUIRED — initialises the field registry for this class
class DistrictModel {
  @Field() id!: string; // type inferred from reflect-metadata (legacy only)
  @Field() name!: string;
  @Field("number") code!: number; // type explicit — required when using TC39 decorators
  @Field() active!: boolean;
  @Field() createdAt!: Date;

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

#### Custom objects / relations via `@Field(Model)` and `@Field([Model])`

`@Field` also accepts **another Model class** (or an array of one) directly. This registers the field as a nested relation **and** makes `@AutoConvert` instantiate/convert the nested object/array recursively — following the nested model's own `@Field()` types, exactly like it does for the base object.

```ts
@InitFields
@ModelTagged
class PostModel {
  static tag = 3001;
  @Field() id!: string;
  @Field() title!: string;
  @Field("number") views!: number;
  @Field("boolean") published!: boolean;
}

@InitFields
@ModelTagged
class UserModel {
  static tag = 3000;
  @Field() id!: string;
  @Field() name!: string;

  @Field(ProfileModel) profile?: ProfileModel; // single nested object
  @Field([PostModel]) posts?: PostModel[]; // array of nested objects

  constructor(data?: Record<string, any>) {
    if (data) this.setData(data); // setData decorated with @AutoConvert
  }
}

const user = new UserModel({
  name: "Ana",
  profile: {bio: "hi", followers: "42"},
  posts: [{title: "A", views: "10", published: "true"}],
});

user.profile; // → ProfileModel instance, followers === 42 (number)
user.posts[0]; // → PostModel instance, views === 10, published === true
```

> **ℹ️ How it behaves:**
>
> - The nested model classes MUST have `@InitFields` + `@Field()`. To be instantiated/converted by `@AutoConvert`, they should expose a `setData(data)` method decorated with `@AutoConvert` (the usual `BaseModel` pattern). Without `setData`, the library falls back to a field-by-field conversion.
> - `null` / `undefined` nested values are passed through unchanged. A single object given to an array field is normalised to a one-element array. Values already instances of the target model are kept as-is.
> - **`getWhere` compatibility:** to-one relations (`@Field(Model)`) are expanded into dot-notation keys (e.g. `profile.bio`) just like `@NestedModel`, producing `{ profile: { bio: { ... } } }`. To-many relations (`@Field([Model])`) are also expanded (e.g. `posts.title`), and `getWhere` wraps the list segment with Prisma's `some` — e.g. `?posts.title=hi` becomes `{ posts: { some: { title: { ... } } } }`. The `some` wrapper is applied at every list level, so chained lists nest correctly (`?articles.tags.label=js` → `{ articles: { some: { tags: { some: { label: { ... } } } } } }`). Only fields that actually exist on the (nested) model are considered — unknown query keys are ignored and never reach the where clause.
> - **Difference from `@NestedModel`:** `@Field(Model)` opts the field into `@AutoConvert` instantiation. `@NestedModel` remains query-only (it never instantiates anything in `@AutoConvert`), so existing code keeps its current behaviour.

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
> - Fields declared as `@Field(Model)` / `@Field([Model])` are instantiated and converted recursively (see [Custom objects / relations](#custom-objects--relations-via-fieldmodel-and-fieldmodel))

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

---

### `@Cacheable` / `@CacheMethod`

In-memory cache with per-entity isolation and automatic invalidation on write methods. No external dependencies.

```ts
import { Cacheable, CacheMethod, clearAllCache, getCacheStats } from "@mateusseiboth/ts-decorators";

@Cacheable({
  ttl: 30_000,                                        // time-to-live in ms
  readMethods: ["get", "list"],                       // methods that read from cache
  writeMethods: ["create", "update", "deleteById"],   // methods that invalidate cache
})
class DistrictController {
  async get(req, res) { /* sets X-Cache: HIT or MISS */ }
  async create(req, res) { /* invalidates all cache entries for this entity */ }

  @CacheMethod({ ttl: 60_000 })  // per-method TTL override
  async findSpecial(req, res) { ... }
}
```

**Cache key** is built from: HTTP method, `baseUrl`, path, route params, query string, pagination headers, and `res.locals.where`/`orderBy`/`paginate`.

**Entity isolation:** cache entries are partitioned by `className → res.locals.entity`. Writing to one entity never invalidates another.

**Limits:** `maxEntries: 200` per entity — oldest entries are evicted when exceeded.

**Testing helpers:**

```ts
clearAllCache(); // wipes everything
getCacheStats(); // → { DistrictController: 12, StreetController: 5 }
```

---

### `@RateLimit` / `@RateLimitMethod`

In-memory sliding window rate limiter. No Redis required.

```ts
import { RateLimit, RateLimitMethod, rateLimitMiddleware, clearRateLimitStore } from "@mateusseiboth/ts-decorators";

// Applied to an entire controller
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

Each audit entry contains:

| Field       | Source                                                    |
| ----------- | --------------------------------------------------------- |
| `action`    | `"CREATE"` / `"UPDATE"` / `"DELETE"`                      |
| `entity`    | Class name without `"Controller"`                         |
| `entityId`  | From `req.params.id`                                      |
| `userId`    | From `res.locals.userInfo.id`                             |
| `entidade`  | From `res.locals.entity`                                  |
| `before`    | Fetched via `prismaModel.findUnique` before the operation |
| `after`     | Captured from the intercepted `res.json` payload          |
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

Wraps every method in the class to prefix all `console.log` calls with a timestamp and the `ClassName -> methodName` path.

```ts
import {logDecorator} from "@mateusseiboth/ts-decorators";

@logDecorator
class MyController {
  async get(req, res) {
    console.log("fetching records...");
    // → "[12/04/2026 14:32:01 - MyController -> get] fetching records..."
  }
}
```

The decorator replaces `console.log` with a prefixed version for the duration of each method call, then restores the global `_console` reference afterwards. Other `console` methods (`warn`, `error`, etc.) are not affected.

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

Wraps `create`, `update`, and `deleteById` with **SQL SAVEPOINTs**, allowing partial rollback within an already-open transaction (`this.DAO.tx`).

```ts
import { TransactionalClass, setTransactionalCompanyFn } from "@mateusseiboth/ts-decorators";

@TransactionalClass
class OrderController { ... }

// Optional: run a function at the start of every transaction opened by
// `Transactional(prisma)` (e.g. for row-level security). Opt-in: without this
// call the middleware injects nothing.
setTransactionalCompanyFn(async (tx, companyId) => {
  await tx.$executeRawUnsafe(`SET LOCAL "app.company_id" = ${companyId}`);
});
```

#### Company id injection (multi-tenant / RLS)

`addCompanyIdToTransaction` — and therefore the `Transactional()` / `withTransaction()` handlers — applies the tenant to the transaction before running the handler. The default strategy is `SET LOCAL "my.company_id" = <id>`, and it is swappable at bootstrap — same idea as `setPrismaClient`:

```ts
import { setCompanyIdInjector, resetCompanyIdInjector, noopCompanyIdInjector } from "@mateusseiboth/ts-decorators";

// Your own convention: another variable, another database, a stored procedure...
setCompanyIdInjector(async (tx, companyId) => {
  await tx.$executeRawUnsafe(`SELECT set_config('app.tenant', $1, true)`, companyId);
});

setCompanyIdInjector(noopCompanyIdInjector); // disables the injection
resetCompanyIdInjector();                    // back to the package default
```

Per-route override, when a single endpoint needs a different strategy:

```ts
router.post("/orders", withTransaction(handler, { action: "create" }, {
  companyIdInjector: async (tx, companyId) => tx.$executeRawUnsafe(`SET LOCAL "my.other_id" = ${Number(companyId)}`),
}));
```

| Function                   | Description                                                            |
| -------------------------- | ---------------------------------------------------------------------- |
| `setCompanyIdInjector(fn)` | Replaces the global strategy — `fn(tx, companyId)`                     |
| `getCompanyIdInjector()`   | Returns the strategy currently in use                                  |
| `resetCompanyIdInjector()` | Restores the package default                                           |
| `defaultCompanyIdInjector` | The default itself (`SET LOCAL "my.company_id"`), reusable in wrappers |
| `noopCompanyIdInjector`    | Empty strategy — injects nothing                                       |

> The legacy `Transactional(prisma)` middleware keeps its own opt-in behaviour: it injects nothing unless you call `setTransactionalCompanyFn` (or pass `companyIdInjector` in its options). `setCompanyIdInjector` does not change it.

---

### `@Validate` / `@WithValidation`

Zod-powered constructor parameter validation.

> **⚠️ `@Validate` is a parameter decorator and is only supported in legacy mode (`experimentalDecorators: true`). TC39 Stage 3 does not support parameter decorators.**

```ts
import {Validate, WithValidation} from "@mateusseiboth/ts-decorators";
import {z} from "zod";

@WithValidation // intercepts the constructor call and runs validation
class CreateOrderController {
  constructor(
    @Validate(z.string().uuid()) orderId: string,
    @Validate(z.number().positive()) total: number,
    @Validate(z.array(z.string()).min(1)) items: string[],
  ) {
    // only reached if all schemas pass; throws ZodError otherwise
  }
}
```

`@WithValidation` (class decorator) wraps the constructor: before `super()` is invoked, it calls `schema.parse(args[index])` for each parameter decorated with `@Validate`. A `ZodError` is thrown immediately on the first failing validation.

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

---

### `@Queue` / `@Processor` + adapters

`@Queue` declara uma fila nomeada sobre um **adapter** com interface comum
(`findMany / findUnique / create / update / delete`). `@Processor` consome essa fila pelo nome.

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

---

## HTTP Routing

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
const paginated = route.withPrismaOptions(Model); // novo builder: getOrderBy + getWhere + getPaginate
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

## Utility Functions

### `makePrismaOptions`

Merges `res.locals.where`, `res.locals.orderBy`, and `res.locals.paginate` into a single object ready to spread into any Prisma `findMany` call.

```ts
import {makePrismaOptions} from "@mateusseiboth/ts-decorators";

// Typically used after getWhere + getOrderBy + getPaginate middlewares have run
const options = makePrismaOptions(res);
// → { where: { AND: [...] }, orderBy: [...], skip: 20, take: 10 }

const records = await prisma.street.findMany(options);
```

> **ℹ️** `where` always has `AND: []` even when empty, so you can safely push extra conditions into it without null-checking.

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
// → {
//     data: {
//       data: Product[],
//       paginacao: { totalPage: 5, page: 2, total: 48 }
//     }
//   }
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

### Other helpers

| Function                            | Description                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `jwtDecode(token)`                  | Decodes (no signature verification) a JWT payload from a base64 string                                       |
| `filterObjectByModel(obj, Model)`   | Strips keys from `obj` that are not registered `@Field()` properties of Model                                |
| `extractAndRemoveByKey(obj, key)`   | Recursively finds the first occurrence of `key`, removes it and returns `{ value, obj }`                     |
| `convertBigIntValues(data)`         | Recursively converts `BigInt` and `Date` values to strings (safe for `JSON.stringify`)                       |
| `addCompanyIdToTransaction(tx, id)` | Applies the tenant to the transaction via the [configured strategy](#company-id-injection-multi-tenant--rls) |

---

## Running tests

```bash
bun test
```

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
- **Support both legacy and TC39 Stage 3 decorator syntax.** Use the `isDecoratorContext` helper from `src/decorators/_proxy.ts` to branch between the two.
- **Emit a `warnLegacy("DecoratorName")` warning** when a decorator is used in legacy mode so users are aware.
- **Do not add runtime dependencies.** All caching, rate limiting and audit logic is intentionally dependency-free.
- **Tests use `bun test`.** Place test files in `tests/` with the `.test.ts` suffix. Reuse the mock helpers in `tests/_helpers.ts` and the model fixtures in `tests/_models.ts`.
- **Do not break the metadata WeakMap contract.** `@InitFields` is the initialiser for the `CLASS_FIELDS` WeakMap — never read from `getFieldTypes` in a decorator that runs before `@InitFields`.

### Adding a new decorator

1. Create `src/decorators/myDecorator.ts`
2. Implement both legacy and TC39 branches using `isDecoratorContext`
3. Export it from `index.ts`
4. Add tests in `tests/myDecorator.test.ts`
5. Document it in this README under the [Decorators](#decorators) section
