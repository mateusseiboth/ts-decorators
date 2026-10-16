/**
 * Injeção das funções de contexto de request.
 *
 * O contexto (usuário, entidade, exercício, transação) é armazenado via
 * AsyncLocalStorage no projeto host. Injete as funções `getContext` e
 * `requireContext` do seu middleware de contexto uma vez no bootstrap:
 *
 * ```ts
 * import { getContext, requireContext } from "@middleware/context";
 * import { setHandlerContext } from "@mateusseiboth/ts-decorators";
 * setHandlerContext(getContext, requireContext);
 * ```
 */

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

let _getContext: ContextGetter = () => undefined;
let _requireContext: ContextRequirer = (
  msg = "[@mateusseiboth/ts-decorators] Contexto não disponível. Chame setHandlerContext() no bootstrap.",
) => {
  throw new Error(msg);
};

/**
 * Injeta as funções de contexto do projeto host.
 * `requireCtx` é opcional — se omitida, usa uma implementação que lança quando
 * `getCtx()` retorna undefined.
 */
export function setHandlerContext(getCtx: ContextGetter, requireCtx?: ContextRequirer): void {
  _getContext = getCtx;
  if (requireCtx) {
    _requireContext = requireCtx;
  } else {
    _requireContext = (msg = "[@mateusseiboth/ts-decorators] Contexto não disponível.") => {
      const ctx = getCtx();
      if (!ctx) throw new Error(msg);
      return ctx;
    };
  }
}

export function getHandlerContext(): HandlerContext | undefined {
  return _getContext();
}

export function requireHandlerContext(message?: string): HandlerContext {
  return _requireContext(message);
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
