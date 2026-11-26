/**
 * `app.errors`: o erro que virou resposta HTTP, pela classe e pelo status. O pacote não tem o
 * `errorHandler` (cada app tem o seu): o app chama `recordAppError` dentro dele.
 *
 * Uso (errorHandler do app):
 *   recordAppError(err, { statusCode: status });
 */

import { METRICA } from "./catalog";
import { incrementMetric } from "./metrics";

export interface RecordAppErrorOptions {
  /** O status da resposta. Default: o `statusCode` (ou `status`) do erro, senão 500. */
  statusCode?: number;
}

/** Valor do OpenTelemetry para o tipo de erro que não se sabe nomear. */
const TIPO_DESCONHECIDO = "_OTHER";
const STATUS_PADRAO = 500;

const isStatusHttp = (valor: unknown): valor is number =>
  Number.isInteger(valor) && (valor as number) >= 100 && (valor as number) <= 599;

/** A classe do erro: nome de código, nunca a mensagem (cardinalidade baixa). */
const readTipo = (error: unknown): string =>
  error instanceof Error ? error.constructor.name || TIPO_DESCONHECIDO : TIPO_DESCONHECIDO;

const readStatus = (error: unknown, options: RecordAppErrorOptions): number => {
  const doErro = error as { statusCode?: unknown; status?: unknown } | null | undefined;
  return (
    [options.statusCode, doErro?.statusCode, doErro?.status].find(isStatusHttp) ?? STATUS_PADRAO
  );
};

/** Conta o erro em `app.errors`, com `error.type` (a classe) e `http.response.status_code`. */
export function recordAppError(error: unknown, options: RecordAppErrorOptions = {}): void {
  incrementMetric({
    ...METRICA.ERRORS,
    attributes: {
      "error.type": readTipo(error),
      "http.response.status_code": readStatus(error, options),
    },
  });
}
