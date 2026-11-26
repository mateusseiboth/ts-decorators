/**
 * Carrega o `@opentelemetry/api` na primeira chamada, não no import.
 *
 * A API é dependência OPCIONAL do código que mora no ponto de entrada principal (decorators,
 * métricas da fila, do Prisma etc.): sem ela instalada, quem observa só deixa de observar. Cada
 * módulo declara o pedaço da API que usa (`TraceApiLike`, `MetricsApiLike`...) e converte o
 * retorno: os tipos do `@opentelemetry/api` não entram, porque o pacote é publicado como
 * código-fonte e o `tsc` de quem não tem a dependência quebraria.
 */

import { createRequire } from "node:module";

const requireOtel = () => createRequire(import.meta.url)("@opentelemetry/api") as unknown;

let _loader: () => unknown = requireOtel;
/** `undefined`: ainda não carregou. `null`: não está instalado. */
let _api: unknown;

const loadApi = (): unknown => {
  try {
    return _loader();
  } catch {
    return null;
  }
};

/** O módulo `@opentelemetry/api`, ou `null` quando não está instalado. */
export function getOtelApi(): unknown {
  _api ??= loadApi();
  return _api;
}

/** Troca quem carrega o `@opentelemetry/api` (testes). Sem argumento, volta ao `require`. */
export function setOtelLoader(loader: () => unknown = requireOtel): void {
  _loader = loader;
  _api = undefined;
}
