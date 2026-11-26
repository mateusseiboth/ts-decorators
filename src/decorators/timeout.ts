/**
 * @Timeout e withTimeout: corta a operação que passa do tempo. O `AbortSignal` da chamada fica
 * disponível em `getTimeoutSignal()`, para o método repassar ao `fetch` e cancelar de verdade.
 *
 * Uso:
 *   @Timeout(5_000)
 *   async findCnpj(cnpj) {
 *     return fetch(url, { signal: getTimeoutSignal() });
 *   }
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { makeMethodDecorator } from "./_method";
import { REGRA, requireOpcoes } from "./_opcoes";

export class TimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} passou de ${timeoutMs} ms.`);
    this.name = "TimeoutError";
  }
}

const OPERACAO_PADRAO = "A operação";

const sinais = new AsyncLocalStorage<AbortSignal>();

const requireTempo = (origem: string, ms: number) =>
  requireOpcoes(origem, { ms }, [{ campo: "ms", ...REGRA.POSITIVO }]);

/** Rejeita com `TimeoutError` (e aborta o controlador) quando o tempo acaba. */
const startRelogio = (controller: AbortController, ms: number, operation: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const estouro = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(operation, ms);
      controller.abort(error);
      reject(error);
    }, ms);
    // Sem `unref`: operação que não segura o processo (ou que nunca termina) ainda estoura o
    // prazo. O relógio é cancelado assim que ela termina, então não prende ninguém à toa.
  });
  return { estouro, stop: () => clearTimeout(timer) };
};

export async function withTimeout<T>(
  fn: (signal: AbortSignal) => T | Promise<T>,
  ms: number,
  operation: string = OPERACAO_PADRAO,
): Promise<T> {
  requireTempo("withTimeout", ms);
  const controller = new AbortController();
  const relogio = startRelogio(controller, ms, operation);
  const execucao = sinais.run(controller.signal, async () => fn(controller.signal));
  try {
    return await Promise.race([execucao, relogio.estouro]);
  } finally {
    relogio.stop();
  }
}

/** O sinal do `@Timeout`/`withTimeout` mais interno da chamada em andamento. */
export function getTimeoutSignal(): AbortSignal | undefined {
  return sinais.getStore();
}

export function Timeout(ms: number): (...args: any[]) => any {
  requireTempo("@Timeout", ms);
  return makeMethodDecorator("Timeout", (original, methodName) => {
    return function (this: any, ...args: any[]) {
      const operation = `${this?.constructor?.name ?? "fn"}.${methodName}`;
      return withTimeout(() => original.apply(this, args), ms, operation);
    };
  });
}
