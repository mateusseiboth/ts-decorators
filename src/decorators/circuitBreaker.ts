/**
 * @CircuitBreaker e withCircuitBreaker: depois de N falhas seguidas o circuito ABRE e as chamadas
 * falham na hora (`CircuitOpenError`), sem esperar a integração fora do ar. Passado o tempo, uma
 * chamada de teste (meio-aberto) decide se fecha ou abre de novo.
 *
 * O estado mora na memória do processo, por nome de circuito: o mesmo nome compartilha o estado.
 *
 * Uso:
 *   @CircuitBreaker({ failureThreshold: 5, resetAfterMs: 30_000 })
 *   async sendLote(lote) { ... }
 */

import { makeMethodDecorator } from "./_method";
import { REGRA, buildOpcoes, type RegraDaOpcao } from "./_opcoes";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Nome do circuito; o mesmo nome compartilha o estado. Default: `Classe.metodo`. */
  name?: string;
  /** Falhas seguidas para abrir. Default: 5. */
  failureThreshold?: number;
  /** Tempo aberto antes da chamada de teste, em ms. Default: 30_000. */
  resetAfterMs?: number;
  /** Decide se o erro conta como falha da integração. Default: todo erro. */
  isFailure?: (error: unknown) => boolean;
}

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  failures: number;
  /** Quando abriu (epoch ms). Só com o circuito aberto ou meio-aberto. */
  openedAt?: number;
}

export class CircuitOpenError extends Error {
  constructor(
    readonly circuit: string,
    readonly retryAfterMs: number,
  ) {
    super(
      `O circuito ${circuit} está aberto. Tente de novo em ${Math.ceil(retryAfterMs / 1000)} s.`,
    );
    this.name = "CircuitOpenError";
  }
}

// ── Estado ────────────────────────────────────────────────────────────────────────────────────

interface Circuito extends CircuitSnapshot {
  /** Meio-aberto com a chamada de teste em andamento: as demais falham na hora. */
  hasTesteEmAndamento: boolean;
}

const circuitos = new Map<string, Circuito>();

const getCircuito = (name: string): Circuito => {
  const existente = circuitos.get(name);
  if (existente) return existente;
  const novo: Circuito = { name, state: "closed", failures: 0, hasTesteEmAndamento: false };
  circuitos.set(name, novo);
  return novo;
};

// ── Opções ────────────────────────────────────────────────────────────────────────────────────

type ConfigDoCircuito = Required<Omit<CircuitBreakerOptions, "name">>;

const PADRAO: ConfigDoCircuito = {
  failureThreshold: 5,
  resetAfterMs: 30_000,
  isFailure: () => true,
};

const REGRAS: readonly RegraDaOpcao<ConfigDoCircuito>[] = [
  { campo: "failureThreshold", ...REGRA.INTEIRO_POSITIVO },
  { campo: "resetAfterMs", ...REGRA.NAO_NEGATIVO },
];

const buildConfig = (
  origem: string,
  { name: _name, ...options }: CircuitBreakerOptions = {},
): ConfigDoCircuito => buildOpcoes(origem, PADRAO, options, REGRAS);

const requireNome = (origem: string, name: unknown) => {
  if (typeof name === "string" && name.length > 0) return;
  throw new TypeError(
    `[@mateusseiboth/ts-decorators] ${origem}: o nome do circuito deve ser um texto não vazio.`,
  );
};

// ── Transições ────────────────────────────────────────────────────────────────────────────────

/** A chamada comum (circuito fechado) ou a chamada de teste (meio-aberto). */
type Chamada = "normal" | "teste";

const open = (circuito: Circuito) => {
  circuito.state = "open";
  circuito.openedAt = Date.now();
  circuito.hasTesteEmAndamento = false;
};

const close = (circuito: Circuito) => {
  circuito.state = "closed";
  circuito.failures = 0;
  circuito.openedAt = undefined;
  circuito.hasTesteEmAndamento = false;
};

const startTeste = (circuito: Circuito): Chamada => {
  circuito.state = "half-open";
  circuito.hasTesteEmAndamento = true;
  return "teste";
};

/** Decide se a chamada passa. Quando não passa, lança `CircuitOpenError` sem chamar a função. */
const ADMISSAO: Record<CircuitState, (circuito: Circuito, config: ConfigDoCircuito) => Chamada> = {
  closed: () => "normal",
  open: (circuito, config) => {
    const restante = (circuito.openedAt ?? 0) + config.resetAfterMs - Date.now();
    if (restante > 0) throw new CircuitOpenError(circuito.name, restante);
    return startTeste(circuito);
  },
  "half-open": (circuito) => {
    // Durante o teste não há prazo a informar: a resposta dele chega a qualquer momento.
    if (circuito.hasTesteEmAndamento) throw new CircuitOpenError(circuito.name, 0);
    return startTeste(circuito);
  },
};

interface Desfecho {
  sucesso: (circuito: Circuito, config: ConfigDoCircuito) => void;
  falha: (circuito: Circuito, config: ConfigDoCircuito) => void;
  /** Erro que `isFailure` não conta: o estado não muda. */
  neutro: (circuito: Circuito, config: ConfigDoCircuito) => void;
}

// Chamada que entrou com o circuito fechado e termina depois de ele abrir não muda mais nada.
const DESFECHO: Record<Chamada, Desfecho> = {
  normal: {
    sucesso: (circuito) => {
      if (circuito.state === "closed") circuito.failures = 0;
    },
    falha: (circuito, config) => {
      if (circuito.state !== "closed") return;
      circuito.failures++;
      if (circuito.failures >= config.failureThreshold) open(circuito);
    },
    neutro: () => undefined,
  },
  teste: {
    sucesso: close,
    falha: (circuito) => {
      circuito.failures++;
      open(circuito);
    },
    neutro: (circuito) => {
      circuito.hasTesteEmAndamento = false;
    },
  },
};

async function runNoCircuito<T>(
  name: string,
  fn: () => T | Promise<T>,
  config: ConfigDoCircuito,
): Promise<T> {
  const circuito = getCircuito(name);
  const desfecho = DESFECHO[ADMISSAO[circuito.state](circuito, config)];
  try {
    const resultado = await fn();
    desfecho.sucesso(circuito, config);
    return resultado;
  } catch (error) {
    desfecho[config.isFailure(error) ? "falha" : "neutro"](circuito, config);
    throw error;
  }
}

// ── API ───────────────────────────────────────────────────────────────────────────────────────

export async function withCircuitBreaker<T>(
  name: string,
  fn: () => T | Promise<T>,
  options?: Omit<CircuitBreakerOptions, "name">,
): Promise<T> {
  requireNome("withCircuitBreaker", name);
  return runNoCircuito(name, fn, buildConfig("withCircuitBreaker", options));
}

export function CircuitBreaker(options?: CircuitBreakerOptions): (...args: any[]) => any {
  const config = buildConfig("@CircuitBreaker", options);
  return makeMethodDecorator("CircuitBreaker", (original, methodName) => {
    return function (this: any, ...args: any[]) {
      const name = options?.name ?? `${this?.constructor?.name ?? "fn"}.${methodName}`;
      return runNoCircuito(name, () => original.apply(this, args), config);
    };
  });
}

const toSnapshot = ({ name, state, failures, openedAt }: Circuito): CircuitSnapshot =>
  openedAt === undefined ? { name, state, failures } : { name, state, failures, openedAt };

export function getCircuits(): CircuitSnapshot[] {
  return [...circuitos.values()].map(toSnapshot).sort((a, b) => a.name.localeCompare(b.name));
}

/** Volta todos os circuitos ao estado fechado (testes). */
export function resetCircuits(): void {
  circuitos.clear();
}
