/**
 * @Trace e withSpan: um span do OpenTelemetry em volta da chamada, com o tenant do contexto
 * (`app.entity`) e os atributos que vierem dos argumentos. Erro vira `recordException` e status
 * ERROR, e é relançado como veio.
 *
 * O `@opentelemetry/api` é dependência OPCIONAL e é carregado na primeira chamada, não no import:
 * sem ele instalado, o decorator só chama o método. Com ele e sem SDK registrado, a própria API
 * não grava nada.
 *
 * Uso:
 *   @Trace({ attributes: (competencia) => ({ competencia }) })
 *   async calcularFolha(competencia) { ... }
 *
 *   await withSpan("esocial.sendLote", () => client.sendLote(lote));
 */

import { logger } from "../functions/logger";
import { getHandlerContext, hasTenant } from "../handlers/context";
import { getOtelApi, setOtelLoader } from "../observability/otelApi";
import { makeMethodDecorator } from "./_method";

export type SpanAttributes = Record<string, string | number | boolean>;

export interface TraceOptions {
  /** Nome do span. Default: `Classe.metodo`. */
  name?: string;
  /** Atributos do span a partir dos argumentos da chamada. */
  attributes?: (...args: any[]) => SpanAttributes;
}

export interface WithSpanOptions {
  /** Atributos do span. */
  attributes?: SpanAttributes;
}

// Só o que o pacote usa da API. Os tipos do `@opentelemetry/api` não entram: o pacote é publicado
// como código-fonte, e o `tsc` de quem não tem a dependência instalada quebraria.
interface SpanLike {
  recordException(exception: Error | string): void;
  setStatus(status: { code: number; message?: string }): unknown;
  end(): void;
}

interface OtelApiLike {
  trace: {
    getTracer(name: string): {
      startActiveSpan<T>(
        name: string,
        options: { attributes: SpanAttributes },
        fn: (span: SpanLike) => T,
      ): T;
    };
  };
  SpanStatusCode: { ERROR: number };
}

const TRACER = "@mateusseiboth/ts-decorators";
const ATRIBUTO_DA_TENANT = "app.entity";

const getApi = (): OtelApiLike | null => getOtelApi() as OtelApiLike | null;

/** Troca quem carrega o `@opentelemetry/api` (testes). */
export { setOtelLoader };

const buildAtributoDoTenant = (): SpanAttributes => {
  const entity = getHandlerContext()?.entity;
  return hasTenant(entity) ? { [ATRIBUTO_DA_TENANT]: entity } : {};
};

/** Atributo que lança não derruba a chamada observada: o span sai sem eles. */
const buildAtributos = (name: string, build: () => SpanAttributes | undefined): SpanAttributes => {
  try {
    return { ...buildAtributoDoTenant(), ...build() };
  } catch (err) {
    logger.error(`[@mateusseiboth/ts-decorators] @Trace: os atributos de ${name} falharam:`, err);
    return buildAtributoDoTenant();
  }
};

const isThenable = (valor: unknown): valor is PromiseLike<unknown> =>
  typeof (valor as PromiseLike<unknown> | undefined)?.then === "function";

const failSpan = (span: SpanLike, error: unknown, errorCode: number): never => {
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error ? error : message);
  span.setStatus({ code: errorCode, message });
  span.end();
  throw error;
};

/** Retorno síncrono fecha o span na volta; thenable, quando termina. */
const runInSpan = (span: SpanLike, errorCode: number, run: () => unknown): unknown => {
  let retorno: unknown;
  try {
    retorno = run();
  } catch (err) {
    return failSpan(span, err, errorCode);
  }

  if (!isThenable(retorno)) {
    span.end();
    return retorno;
  }
  return retorno.then(
    (valor) => {
      span.end();
      return valor;
    },
    (err: unknown) => failSpan(span, err, errorCode),
  );
};

const runTraced = (
  name: string,
  buildAttributes: () => SpanAttributes | undefined,
  run: () => unknown,
): unknown => {
  const api = getApi();
  if (!api) return run();
  return api.trace
    .getTracer(TRACER)
    .startActiveSpan(name, { attributes: buildAtributos(name, buildAttributes) }, (span) =>
      runInSpan(span, api.SpanStatusCode.ERROR, run),
    );
};

/** Roda `fn` dentro de um span com esse nome. */
export function withSpan<T>(name: string, fn: () => T, options?: WithSpanOptions): T {
  return runTraced(name, () => options?.attributes, fn) as T;
}

export function Trace(options?: TraceOptions): (...args: any[]) => any {
  return makeMethodDecorator("Trace", (original, methodName) => {
    return function (this: any, ...args: any[]) {
      const name = options?.name ?? `${this?.constructor?.name ?? "fn"}.${methodName}`;
      return runTraced(
        name,
        () => options?.attributes?.(...args),
        () => original.apply(this, args),
      );
    };
  });
}
