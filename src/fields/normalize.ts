/**
 * Normalização do valor de um campo (`@Field({ normalize })`), aplicada na gravação e no filtro
 * do `getWhere`. É o que faz o CPF digitado com máscara achar o CPF gravado sem ela.
 */

/** Os normalizadores prontos. */
export type FieldNormalizeName = "digits" | "trim" | "upper";

/** Função própria: recebe o texto e devolve o texto normalizado. */
export type FieldNormalizeFn = (value: string) => string;

/**
 * O que o `normalize` do `@Field` aceita: um normalizador pronto, uma função própria ou uma
 * lista dos dois, aplicada na ordem.
 */
export type FieldNormalize =
  | FieldNormalizeName
  | FieldNormalizeFn
  | ReadonlyArray<FieldNormalizeName | FieldNormalizeFn>;

const NORMALIZERS: Record<FieldNormalizeName, FieldNormalizeFn> = {
  digits: (value) => value.replace(/\D/g, ""),
  trim: (value) => value.trim().replace(/\s+/g, " "),
  upper: (value) => value.toUpperCase(),
};

const resolveStep = (step: FieldNormalizeName | FieldNormalizeFn): FieldNormalizeFn => {
  if (typeof step === "function") return step;
  const normalizer = NORMALIZERS[step];
  if (!normalizer)
    throw new Error(
      `[@mateusseiboth/ts-decorators] Normalizador desconhecido no @Field: "${step}".`,
    );
  return normalizer;
};

const toSteps = (
  normalize: FieldNormalize,
): ReadonlyArray<FieldNormalizeName | FieldNormalizeFn> =>
  Array.isArray(normalize) ? normalize : [normalize as FieldNormalizeName | FieldNormalizeFn];

/**
 * Aplica o `normalize` ao valor. Só texto é normalizado: `null`, `undefined`, texto vazio e o que
 * não é texto passam intactos.
 */
export function normalizeValue<T>(value: T, normalize: FieldNormalize | undefined): T {
  if (!normalize || typeof value !== "string" || value === "") return value;
  return toSteps(normalize).reduce((atual, step) => resolveStep(step)(atual), value as string) as T;
}
