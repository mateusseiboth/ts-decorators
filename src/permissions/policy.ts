/**
 * Motor de políticas ABAC. Avalia `conditions` (AND de caminhos, AND de operadores) contra os
 * atributos do `PolicyContext`. Sem condições, permite.
 *
 * Operadores em strategy map: estender é adicionar uma entrada, nunca um `if`.
 */
import type { ConditionOperators, Conditions, PolicyContext } from "./types";

type Operator = (actual: unknown, expected: unknown, ctx: PolicyContext) => boolean;

/** `undefined`, `null` e texto vazio não identificam ninguém. */
const isIdentidade = (value: unknown): boolean => value != null && value !== "";

/**
 * O dono do recurso é o usuário autenticado. Compara como texto (id numérico no token, texto no
 * banco) e NEGA quando falta um dos dois: `undefined === undefined` não é o mesmo dono.
 */
const isDono = (owner: unknown, ctx: PolicyContext): boolean => {
  const userId = ctx.user?.id;
  return isIdentidade(owner) && isIdentidade(userId) && String(owner) === String(userId);
};

const OPERATORS: Record<keyof ConditionOperators, Operator> = {
  eq: (actual, expected) => actual === expected,
  ne: (actual, expected) => actual !== expected,
  in: (actual, expected) => Array.isArray(expected) && expected.includes(actual),
  gt: (actual, expected) => Number(actual) > Number(expected),
  lt: (actual, expected) => Number(actual) < Number(expected),
  ownerId: (actual, expected, ctx) => expected !== true || isDono(actual, ctx),
};

/** A raiz é atributo PRÓPRIO do contexto: `constructor` e companhia não são caminho. */
const readRaiz = (ctx: PolicyContext, root: string): unknown =>
  Object.hasOwn(ctx, root) ? ctx[root] : undefined;

/** Resolve `resource.status`, `user.id`, `entity` contra o contexto. */
function resolvePath(ctx: PolicyContext, path: string): unknown {
  const [root = "", ...rest] = path.split(".");
  return rest.reduce<unknown>(
    (accumulated, key) =>
      accumulated == null ? undefined : (accumulated as Record<string, unknown>)[key],
    readRaiz(ctx, root),
  );
}

/** Operador que o motor não conhece (erro de digitação no catálogo) reprova: falha fechada. */
const UNKNOWN_OPERATOR: Operator = () => false;

function matchesOperators(actual: unknown, ops: ConditionOperators, ctx: PolicyContext): boolean {
  return (Object.keys(ops) as (keyof ConditionOperators)[]).every((operator) =>
    (Object.hasOwn(OPERATORS, operator) ? OPERATORS[operator] : UNKNOWN_OPERATOR)(
      actual,
      ops[operator],
      ctx,
    ),
  );
}

export function evaluateConditions(
  conditions: Conditions | undefined,
  ctx: PolicyContext,
): boolean {
  if (!conditions) return true;
  return Object.entries(conditions).every(([path, ops]) =>
    matchesOperators(resolvePath(ctx, path), ops, ctx),
  );
}
