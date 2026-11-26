/**
 * @Retry e withRetry: novas tentativas com espera crescente (exponencial, com sorteio) para
 * integrações instáveis (eSocial, Receita, serviço de e-mail).
 *
 * A tentativa n (1 = a primeira) que falha espera `min(maxDelayMs, delayMs * factor^(n-1))`; com
 * `jitter`, a espera é sorteada entre a metade e o valor cheio. Esgotadas as tentativas, o ÚLTIMO
 * erro é relançado como veio (o `instanceof` de quem chama continua funcionando).
 *
 * Uso:
 *   @Retry({ attempts: 4, delayMs: 500 })
 *   async sendLote(lote) { ... }
 */

import { makeMethodDecorator } from "./_method";
import { REGRA, buildOpcoes, type RegraDaOpcao } from "./_opcoes";
import { CircuitOpenError } from "./circuitBreaker";

export interface RetryOptions {
  /** Total de tentativas, a primeira inclusive. Default: 3. */
  attempts?: number;
  /** Espera antes da segunda tentativa, em ms. Default: 200. */
  delayMs?: number;
  /** Multiplicador da espera a cada nova tentativa. Default: 2. */
  factor?: number;
  /** Teto da espera, em ms. Default: 10_000. */
  maxDelayMs?: number;
  /** Sorteia a espera entre a metade e o valor cheio, para as instâncias não baterem juntas. Default: true. */
  jitter?: boolean;
  /** Decide se o erro merece nova tentativa. Default: todo erro, menos `CircuitOpenError`. */
  retryIf?: (error: unknown, attempt: number) => boolean;
  /** Chamado antes de cada espera, com a tentativa que falhou (1 = a primeira). */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

type ConfigDoRetry = Required<Omit<RetryOptions, "onRetry">> & Pick<RetryOptions, "onRetry">;

// Circuito aberto já é a resposta: tentar de novo só bateria no mesmo circuito fechado na cara.
const isRetryavel = (error: unknown) => !(error instanceof CircuitOpenError);

const PADRAO: ConfigDoRetry = {
  attempts: 3,
  delayMs: 200,
  factor: 2,
  maxDelayMs: 10_000,
  jitter: true,
  retryIf: isRetryavel,
};

const REGRAS: readonly RegraDaOpcao<ConfigDoRetry>[] = [
  { campo: "attempts", ...REGRA.INTEIRO_POSITIVO },
  { campo: "delayMs", ...REGRA.NAO_NEGATIVO },
  { campo: "factor", ...REGRA.MINIMO_UM },
  { campo: "maxDelayMs", ...REGRA.NAO_NEGATIVO },
];

const buildConfig = (origem: string, options: RetryOptions = {}): ConfigDoRetry =>
  buildOpcoes(origem, PADRAO, options, REGRAS);

const SORTEIO = {
  true: (espera: number) => espera / 2 + Math.random() * (espera / 2),
  false: (espera: number) => espera,
} as const;

/** A espera depois da tentativa `attempt` (1 = a primeira) que falhou. */
const getEspera = (attempt: number, config: ConfigDoRetry) => {
  const cheia = Math.min(config.maxDelayMs, config.delayMs * config.factor ** (attempt - 1));
  return SORTEIO[`${config.jitter}`](cheia);
};

const isNovaTentativa = (error: unknown, attempt: number, config: ConfigDoRetry) =>
  attempt < config.attempts && config.retryIf(error, attempt);

// Sem `unref`: a nova tentativa disparada sem `await` (envio em segundo plano) não pode ser
// perdida porque o script terminou no meio da espera.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runTentativa<T>(
  fn: () => T | Promise<T>,
  config: ConfigDoRetry,
  attempt: number,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isNovaTentativa(error, attempt, config)) throw error;
    const espera = getEspera(attempt, config);
    config.onRetry?.(error, attempt, espera);
    await sleep(espera);
    return runTentativa(fn, config, attempt + 1);
  }
}

export async function withRetry<T>(fn: () => T | Promise<T>, options?: RetryOptions): Promise<T> {
  return runTentativa(fn, buildConfig("withRetry", options), 1);
}

export function Retry(options?: RetryOptions): (...args: any[]) => any {
  const config = buildConfig("@Retry", options);
  return makeMethodDecorator("Retry", (original) => {
    return function (this: any, ...args: any[]) {
      return runTentativa(() => original.apply(this, args), config, 1);
    };
  });
}
