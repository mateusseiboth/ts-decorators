/**
 * Injeção das funções de contexto de request.
 *
 * O contexto (usuário, tenant, exercício, transação) é armazenado via
 * AsyncLocalStorage no projeto host. Injete as funções `getContext` e
 * `requireContext` do seu middleware de contexto uma vez no bootstrap:
 *
 * ```ts
 * import { getContext, requireContext } from "@middleware/context";
 * import { setHandlerContext } from "@mateusseiboth/ts-decorators";
 * setHandlerContext(getContext, requireContext);
 * ```
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Contexto mínimo esperado pelos handlers. O objeto pode ter campos extras. */
export interface HandlerContext {
  transaction?: any;
  entity?: string | number;
  exercicio?: number;
  requestId?: string;
  user?: { id?: string; userId?: string; username?: string; [key: string]: any };
  [key: string]: any;
}

type ContextGetter = () => HandlerContext | undefined;
type ContextRequirer = (message?: string) => HandlerContext;
type ContextRunner = <T>(ctx: HandlerContext, fn: () => T) => T;

export interface HandlerContextOptions {
  /**
   * Abre um contexto em volta de `fn` no armazenamento do projeto (`store.run(ctx, fn)`). É o que
   * o `runWithHandlerContext` usa: com ele, o código do próprio projeto também enxerga o contexto
   * aberto.
   * Sem ele, o pacote guarda o contexto aberto num armazenamento seu, que só o pacote lê.
   */
  run?: ContextRunner;
  /**
   * Chaves do contexto que guardam transação, além de `transaction` (que o pacote lê e é sempre
   * incluída). Quem abre o contexto de outro tenant não as leva: a transação de fora tem o
   * `set_config` do tenant de fora. Ex.: `["tx8", "_tx8Override"]`. Default: só `transaction`.
   */
  transactionKeys?: readonly string[];
}

const MENSAGEM_SEM_REGISTRO =
  "[@mateusseiboth/ts-decorators] Contexto não disponível. Chame setHandlerContext() no bootstrap.";

/** Os contextos abertos pelo pacote quando o projeto não registrou o `run`. */
const _abertos = new AsyncLocalStorage<HandlerContext>();

const runAberto: ContextRunner = (ctx, fn) => _abertos.run(ctx, fn);

let _getContext: ContextGetter = () => undefined;
let _requireContext: ContextRequirer = (msg = MENSAGEM_SEM_REGISTRO) => {
  throw new Error(msg);
};
let _runContext: ContextRunner = runAberto;

const TRANSACTION_KEY = "transaction";
let _transactionKeys: readonly string[] = [TRANSACTION_KEY];

const buildRequirer =
  (getCtx: ContextGetter): ContextRequirer =>
  (msg = "[@mateusseiboth/ts-decorators] Contexto não disponível.") => {
    const ctx = getCtx();
    if (!ctx) throw new Error(msg);
    return ctx;
  };

/**
 * Injeta as funções de contexto do projeto host.
 * `requireCtx` é opcional: se omitida, usa uma implementação que lança quando `getCtx()` retorna
 * undefined. `options.run` abre um contexto no armazenamento do projeto (`runWithHandlerContext`), e
 * `options.transactionKeys` diz onde o projeto guarda a transação.
 */
export function setHandlerContext(
  getCtx: ContextGetter,
  requireCtx?: ContextRequirer,
  options?: HandlerContextOptions,
): void {
  _getContext = getCtx;
  _requireContext = requireCtx ?? buildRequirer(getCtx);
  _runContext = options?.run ?? runAberto;
  _transactionKeys = [...new Set([TRANSACTION_KEY, ...(options?.transactionKeys ?? [])])];
}

/** As chaves de transação do contexto: `transaction` e as do `transactionKeys`. */
export function getTransactionKeys(): readonly string[] {
  return _transactionKeys;
}

export function getHandlerContext(): HandlerContext | undefined {
  return _abertos.getStore() ?? _getContext();
}

export function requireHandlerContext(message?: string): HandlerContext {
  return _abertos.getStore() ?? _requireContext(message);
}

/**
 * O contexto tem tenant (`entity`). `0` e texto vazio contam como sem tenant: é com eles que o
 * middleware dos apps abre o contexto antes de ler o token.
 */
export function hasTenant(tenant: unknown): tenant is NonNullable<HandlerContext["entity"]> {
  return (
    (typeof tenant === "number" && tenant !== 0) || (typeof tenant === "string" && tenant !== "")
  );
}

/** Roda `fn` com `ctx` como o contexto atual: no armazenamento do projeto, ou no do pacote. */
export function runWithHandlerContext<T>(ctx: HandlerContext, fn: () => T): T {
  return _runContext(ctx, fn);
}

/**
 * A transação em uso para a instância: a do contexto do handler, a do DAO (`this.DAO.tx`) ou a da
 * própria instância (`this.tx`), nesta ordem.
 */
export function findTransaction(instance: any): unknown {
  return getHandlerContext()?.transaction ?? instance?.DAO?.tx ?? instance?.tx;
}

/**
 * Publica um valor do request tanto no `res.locals` quanto no contexto, quando
 * há um configurado.
 *
 * Projeto que guarda o estado do request no AsyncLocalStorage (e não no `res`)
 * precisava forkar os middlewares só para trocar o destino da escrita.
 */
export function publishRequestValue(res: any, key: string, value: unknown): void {
  if (res?.locals) res.locals[key] = value;
  const ctx = getHandlerContext();
  if (ctx) ctx[key] = value;
}

/** Texto que separa um tenant do outro nas chaves de cache (contagem, `@Cacheable`). */
export type TenantScopeResolver = () => string | undefined;

let _tenantScope: TenantScopeResolver | null = null;

/**
 * Troca a origem do escopo do tenant. O padrão é a `entity` do contexto; com RLS por várias GUCs
 * (conta, academia, rede...), o escopo precisa de todas, senão o total de um tenant serve a outro.
 */
export function setTenantScope(resolver: TenantScopeResolver): void {
  _tenantScope = resolver;
}

/** Volta ao escopo padrão (a `entity` do contexto). */
export function resetTenantScope(): void {
  _tenantScope = null;
}

/** O resolvedor configurado por `setTenantScope`, ou `null` no padrão. */
export function findTenantScope(): TenantScopeResolver | null {
  return _tenantScope;
}

/** O escopo do tenant atual: o do `setTenantScope`, ou a `entity` do contexto (`"0"` sem ela). */
export function getTenantScope(): string {
  return _tenantScope?.() ?? String(getHandlerContext()?.entity ?? 0);
}
