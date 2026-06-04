/**
 * Injeção das funções de contexto de request.
 *
 * O contexto (usuário, entidade, exercício, transação) é armazenado via
 * AsyncLocalStorage no projeto host. Injete as funções `getContext` e
 * `requireContext` do seu middleware de contexto uma vez no bootstrap:
 *
 * ```ts
 * import { getContext, requireContext } from "@middleware/context";
 * import { setHandlerContext } from "@qualitysistemas/bun-commons";
 * setHandlerContext(getContext, requireContext);
 * ```
 */

/** Contexto mínimo esperado pelos handlers. O objeto pode ter campos extras. */
export interface HandlerContext {
  transaction?: any;
  entity?: string | number;
  exercicio?: number;
  requestId?: string;
  user?: {id?: string; userId?: string; username?: string; [key: string]: any};
  [key: string]: any;
}

type ContextGetter = () => HandlerContext | undefined;
type ContextRequirer = (message?: string) => HandlerContext;

let _getContext: ContextGetter = () => undefined;
let _requireContext: ContextRequirer = (msg = "[@QS-BUN] Contexto não disponível. Chame setHandlerContext() no bootstrap.") => {
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
    _requireContext = (msg = "[@QS-BUN] Contexto não disponível.") => {
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
