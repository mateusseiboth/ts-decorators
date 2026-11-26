/**
 * Motor ABAC das permissões (`evaluateConditions`), com o caso degenerado do `ownerId`.
 */
import { describe, expect, test } from "bun:test";

import { evaluateConditions } from "../src/permissions/policy";
import type { PolicyContext } from "../src/permissions/types";

const ctx: PolicyContext = {
  user: { id: "user-1", cargo: "fiscal" },
  entity: 7,
  resource: { ownerId: "user-1", status: "ABERTO", valor: 500 },
  env: { exercicio: 2026 },
};

describe("evaluateConditions", () => {
  test("sem condições, permite", () => {
    expect(evaluateConditions(undefined, ctx)).toBeTrue();
    expect(evaluateConditions({}, ctx)).toBeTrue();
  });

  test("cada operador resolve seu caminho no contexto", () => {
    expect(evaluateConditions({ "resource.status": { eq: "ABERTO" } }, ctx)).toBeTrue();
    expect(evaluateConditions({ "resource.status": { eq: "FECHADO" } }, ctx)).toBeFalse();
    expect(evaluateConditions({ "resource.status": { ne: "FECHADO" } }, ctx)).toBeTrue();
    expect(evaluateConditions({ "user.cargo": { in: ["fiscal", "auditor"] } }, ctx)).toBeTrue();
    expect(evaluateConditions({ "user.cargo": { in: ["auditor"] } }, ctx)).toBeFalse();
    expect(evaluateConditions({ "resource.valor": { gt: 100, lt: 1000 } }, ctx)).toBeTrue();
    expect(evaluateConditions({ "resource.valor": { gt: 900 } }, ctx)).toBeFalse();
    expect(evaluateConditions({ entity: { eq: 7 } }, ctx)).toBeTrue();
    expect(evaluateConditions({ "env.exercicio": { eq: 2026 } }, ctx)).toBeTrue();
  });

  test("ne sobre resource.status: encerrar só o que não está finalizado", () => {
    const condicao = { "resource.status": { ne: "FINALIZADO" } };

    expect(evaluateConditions(condicao, { ...ctx, resource: { status: "INICIADO" } })).toBeTrue();
    expect(
      evaluateConditions(condicao, { ...ctx, resource: { status: "FINALIZADO" } }),
    ).toBeFalse();
  });

  test("caminhos e operadores combinam em AND", () => {
    expect(
      evaluateConditions(
        { "resource.status": { eq: "ABERTO" }, "resource.valor": { gt: 100 } },
        ctx,
      ),
    ).toBeTrue();
    expect(
      evaluateConditions(
        { "resource.status": { eq: "ABERTO" }, "resource.valor": { gt: 900 } },
        ctx,
      ),
    ).toBeFalse();
  });

  test("caminho inexistente não estoura e simplesmente não casa", () => {
    expect(evaluateConditions({ "resource.nada.aqui": { eq: 1 } }, ctx)).toBeFalse();
  });

  test("raiz que o app publica nos atributos também é caminho", () => {
    const withAlmoxarifado: PolicyContext = { ...ctx, almoxarifadoId: "A1" };

    expect(evaluateConditions({ almoxarifadoId: { eq: "A1" } }, withAlmoxarifado)).toBeTrue();
    expect(evaluateConditions({ almoxarifadoId: { eq: "A2" } }, withAlmoxarifado)).toBeFalse();
  });

  test("operador desconhecido reprova em vez de estourar", () => {
    const digitadoErrado = { "resource.status": { igual: "ABERTO" } } as never;

    expect(evaluateConditions(digitadoErrado, ctx)).toBeFalse();
  });

  test("raiz herdada do Object não é atributo", () => {
    expect(evaluateConditions({ "constructor.name": { eq: "Object" } }, ctx)).toBeFalse();
  });
});

describe("ownerId", () => {
  const condicao = { "resource.ownerId": { ownerId: true } };

  test("compara o dono do recurso com o usuário autenticado", () => {
    expect(evaluateConditions(condicao, ctx)).toBeTrue();
    expect(evaluateConditions(condicao, { ...ctx, user: { id: "outro" } })).toBeFalse();
  });

  test("compara como texto: id numérico e id em texto são o mesmo dono", () => {
    expect(
      evaluateConditions(condicao, { user: { id: 42 }, resource: { ownerId: "42" } }),
    ).toBeTrue();
  });

  test("nega quando falta o dono do recurso", () => {
    expect(evaluateConditions(condicao, { user: { id: "user-1" }, resource: {} })).toBeFalse();
    expect(evaluateConditions(condicao, { user: { id: "user-1" } })).toBeFalse();
  });

  test("nega quando falta o id do usuário", () => {
    expect(evaluateConditions(condicao, { user: {}, resource: { ownerId: "user-1" } })).toBeFalse();
    expect(evaluateConditions(condicao, { resource: { ownerId: "user-1" } })).toBeFalse();
  });

  test("os dois ausentes não são o mesmo dono", () => {
    expect(evaluateConditions(condicao, { user: {}, resource: {} })).toBeFalse();
    expect(evaluateConditions(condicao, {})).toBeFalse();
    expect(
      evaluateConditions(condicao, { user: { id: "" }, resource: { ownerId: "" } }),
    ).toBeFalse();
  });

  test("ownerId: false não exige nada", () => {
    expect(evaluateConditions({ "resource.ownerId": { ownerId: false } }, {})).toBeTrue();
  });
});
