/**
 * O que o `observeHttp` sabe da requisição em andamento (id, tenant, usuário), para o logger correlacionar
 * a linha mesmo quando o projeto não registrou o `setHandlerContext`.
 *
 * Não importa `@opentelemetry/*`: o logger, no ponto de entrada principal, lê daqui.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestScope {
  requestId: string;
  /** Só quando o contexto do handler tinha tenant (o log de acesso sai depois dele). */
  tenant?: string | number;
  userId?: string;
}

const _scope = new AsyncLocalStorage<RequestScope>();

/** Roda `fn` com `scope` como a requisição atual. */
export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return _scope.run(scope, fn);
}

/** A requisição atual, quando há uma aberta pelo `observeHttp`. */
export function getRequestScope(): RequestScope | undefined {
  return _scope.getStore();
}
