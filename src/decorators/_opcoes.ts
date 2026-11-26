/**
 * Validação das opções numéricas dos decorators de operação (@Retry, @Timeout, @CircuitBreaker).
 * Opção errada lança na hora de decorar (ou na chamada do `with*`), não no meio da integração.
 */

export interface Regra {
  isValido: (valor: unknown) => boolean;
  /** Como a mensagem descreve o valor esperado: "um inteiro maior ou igual a 1". */
  esperado: string;
}

const isNumeroFinito = (valor: unknown): valor is number =>
  typeof valor === "number" && Number.isFinite(valor);

export const REGRA = {
  INTEIRO_POSITIVO: {
    isValido: (valor) => Number.isInteger(valor) && (valor as number) >= 1,
    esperado: "um inteiro maior ou igual a 1",
  },
  NAO_NEGATIVO: {
    isValido: (valor) => isNumeroFinito(valor) && valor >= 0,
    esperado: "um número finito maior ou igual a 0",
  },
  POSITIVO: {
    isValido: (valor) => isNumeroFinito(valor) && valor > 0,
    esperado: "um número finito maior que 0",
  },
  MINIMO_UM: {
    isValido: (valor) => isNumeroFinito(valor) && valor >= 1,
    esperado: "um número finito maior ou igual a 1",
  },
} as const satisfies Record<string, Regra>;

export type RegraDaOpcao<T> = Regra & { campo: keyof T & string };

/** `{ attempts: undefined }` não pode apagar o default. */
const withoutIndefinidos = <T extends object>(options: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(options).filter(([, valor]) => valor !== undefined),
  ) as Partial<T>;

/** Junta as opções ao padrão e valida. */
export const buildOpcoes = <T extends object>(
  origem: string,
  padrao: T,
  options: Partial<T>,
  regras: readonly RegraDaOpcao<T>[],
): T => requireOpcoes(origem, { ...padrao, ...withoutIndefinidos(options) }, regras);

/** Devolve as opções se todas as regras passam; senão lança citando a primeira que falhou. */
export function requireOpcoes<T>(origem: string, opcoes: T, regras: readonly RegraDaOpcao<T>[]): T {
  const invalida = regras.find((regra) => !regra.isValido(opcoes[regra.campo]));
  if (!invalida) return opcoes;
  throw new RangeError(
    `[@mateusseiboth/ts-decorators] ${origem}: ${invalida.campo} deve ser ${invalida.esperado} (recebeu ${String(opcoes[invalida.campo])}).`,
  );
}
