/**
 * Máscara de credenciais para o que sai em log e em span. Vale para header, atributo de log e
 * corpo de requisição: a chave é o que decide, nunca o valor.
 *
 * Não importa `@opentelemetry/*`: o logger, no ponto de entrada principal, também usa.
 */

export const REDACTED = "[redacted]";
const CIRCULAR = "[circular]";

/** Chaves sensíveis pelo nome exato (comparadas em minúsculas). */
const CHAVES_SENSIVEIS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-drain-token",
  "proxy-authorization",
]);

/** Qualquer chave que contenha um destes pedaços. */
const PADRAO_SENSIVEL = /token|secret|senha|password/i;

export function isSensitiveKey(key: string): boolean {
  return CHAVES_SENSIVEIS.has(key.toLowerCase()) || PADRAO_SENSIVEL.test(key);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Redactor = (value: unknown, seen: WeakSet<object>) => unknown;

const redactArray: Redactor = (value, seen) =>
  (value as unknown[]).map((item) => redactAny(item, seen));

const redactObject: Redactor = (value, seen) =>
  Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactAny(child, seen),
    ]),
  );

/** `Date`, `Error`, `Map`... ficam como vieram: quem serializa decide o formato. */
const shouldWalk = (value: unknown): value is object =>
  Array.isArray(value) || (isPlainObject(value) && isLiteralObject(value));

const isLiteralObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function redactAny(value: unknown, seen: WeakSet<object>): unknown {
  if (!shouldWalk(value)) return value;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  const redact = Array.isArray(value) ? redactArray : redactObject;
  const result = redact(value, seen);
  seen.delete(value);
  return result;
}

/**
 * Cópia do valor com as chaves sensíveis trocadas por `[redacted]`, em qualquer profundidade.
 * Referência circular vira `[circular]`. O original não é tocado.
 */
export function redactSensitive<T>(value: T): T {
  return redactAny(value, new WeakSet()) as T;
}
