/**
 * @IdempotentMethod e withIdempotency: a mesma operação, pedida de novo, não roda duas vezes.
 * Para onde o middleware `Idempotent` não chega: mensagem que a fila entrega duas vezes, job
 * refeito depois de uma falha no meio.
 *
 * - Mesma chave em voo: quem chega depois recebe a mesma promessa.
 * - Mesma chave concluída dentro de `ttlMs`: devolve o resultado guardado, sem rodar.
 * - Falha não é guardada: a próxima chamada roda de novo.
 *
 * A chave inclui o tenant do contexto (`getHandlerContext`), quando houver: a mesma mensagem
 * de dois municípios são duas operações.
 *
 * Fica na memória do processo: não sobrevive a reinício e não vale entre instâncias.
 *
 * Cada chamada respondida pela operação guardada (em voo ou concluída) conta em
 * `app.idempotency.replay`.
 *
 * Uso:
 *   @IdempotentMethod({ key: (mensagem) => mensagem.id })
 *   async onPagamento(mensagem) { ... }
 *
 *   await withIdempotency(`baixa:${parcela.id}`, () => applyBaixa(parcela));
 */

import { getHandlerContext } from "../handlers/context";
import { METRICA } from "../observability/catalog";
import { incrementMetric } from "../observability/metrics";
import { makeMethodDecorator } from "./_method";
import { REGRA, buildOpcoes, type RegraDaOpcao } from "./_opcoes";

export interface WithIdempotencyOptions {
  /** Por quantos milissegundos o resultado fica guardado depois de concluir. Default: 600_000 (10 min). */
  ttlMs?: number;
}

export interface IdempotentMethodOptions extends WithIdempotencyOptions {
  /** Chave da operação a partir dos argumentos (o id da mensagem, do job). */
  key: (...args: any[]) => string;
}

type ConfigDaIdempotencia = Required<WithIdempotencyOptions>;

const PADRAO: ConfigDaIdempotencia = { ttlMs: 600_000 };

const REGRAS: readonly RegraDaOpcao<ConfigDaIdempotencia>[] = [
  { campo: "ttlMs", ...REGRA.POSITIVO },
];

const buildConfig = (origem: string, options: WithIdempotencyOptions = {}) =>
  buildOpcoes(origem, PADRAO, { ttlMs: options.ttlMs }, REGRAS);

// Global: "e:<tenant>|<chave>" → a promessa da operação (em voo ou concluída no prazo).
const _operacoes = new Map<string, Promise<unknown>>();

const buildChave = (key: string) => `e:${getHandlerContext()?.entity ?? ""}|${key}`;

const startOperacao = <T>(
  chave: string,
  fn: () => T | Promise<T>,
  config: ConfigDaIdempotencia,
): Promise<T> => {
  // `resolve(fn())` dentro do executor: o erro síncrono de `fn` vira rejeição, como no assíncrono.
  const promessa = new Promise<T>((resolve) => resolve(fn()));
  const release = () => {
    if (_operacoes.get(chave) === promessa) _operacoes.delete(chave);
  };
  // Sucesso fica guardado até o prazo; o timer não segura o processo de pé.
  const keepUntilTtl = () => setTimeout(release, config.ttlMs).unref?.();
  promessa.then(keepUntilTtl, release);
  _operacoes.set(chave, promessa);
  return promessa;
};

const runIdempotente = <T>(
  key: string,
  fn: () => T | Promise<T>,
  config: ConfigDaIdempotencia,
): Promise<T> => {
  const chave = buildChave(key);
  const existente = _operacoes.get(chave) as Promise<T> | undefined;
  if (!existente) return startOperacao(chave, fn, config);
  incrementMetric(METRICA.IDEMPOTENCY_REPLAY);
  return existente;
};

export function withIdempotency<T>(
  key: string,
  fn: () => T | Promise<T>,
  options?: WithIdempotencyOptions,
): Promise<T> {
  return runIdempotente(key, fn, buildConfig("withIdempotency", options));
}

export function IdempotentMethod(options: IdempotentMethodOptions): (...args: any[]) => any {
  if (typeof options?.key !== "function") {
    throw new TypeError(
      "[@mateusseiboth/ts-decorators] @IdempotentMethod: informe key, a função que monta a chave.",
    );
  }
  const config = buildConfig("@IdempotentMethod", options);
  return makeMethodDecorator("IdempotentMethod", (original, methodName) => {
    return function (this: any, ...args: any[]) {
      const escopo = `${this?.constructor?.name ?? "fn"}.${methodName}`;
      return runIdempotente(
        `${escopo}:${options.key(...args)}`,
        () => original.apply(this, args),
        config,
      );
    };
  });
}
