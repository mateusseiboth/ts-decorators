/**
 * Decisão de permissão: `isAuthorized`, `authorize`, `isAllowed` e `decideRouteAccess`, com a
 * configuração injetada. Cobre os cenários dos apps que usam as permissões, mais as
 * decisões da lib (tag negativa, fora de requisição, não configurado, mensagens).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import "reflect-metadata";

import { ModelTagged } from "../src/decorators/getModel";
import { setHandlerContext } from "../src/handlers/context";
import {
  authorize,
  decideRouteAccess,
  isAllowed,
  isAuthorized,
  parseKey,
} from "../src/permissions/authorize";
import { configurePermissions, resetPermissions } from "../src/permissions/config";
import { DEFAULT_PERMISSION_MESSAGES, METHOD_TO_ACTION } from "../src/permissions/constants";
import { PermissionDeniedError } from "../src/permissions/PermissionDeniedError";
import type {
  CatalogAugmentation,
  PermissionsConfig,
  PolicyContext,
  Roles,
} from "../src/permissions/types";
import { captureWarnings } from "./_helpers";

const warnCap = captureWarnings();

@ModelTagged
class UsuarioAutorizacaoModel {
  static tag = 4301;
  static nome = "Usuários";
}

warnCap.restore();

const TAG = UsuarioAutorizacaoModel.tag;
const TENANT = 7;

const CATALOGO: CatalogAugmentation = {
  [TAG]: {
    actions: {
      "trocar-avatar": {
        label: "Trocar avatar",
        conditions: { "resource.ownerId": { ownerId: true } },
      },
      "enviar-boas-vindas": { label: "Enviar boas-vindas" },
    },
  },
};

interface Contexto {
  user: Record<string, unknown>;
  entity: number;
  isSuporte?: boolean;
}

const store = new AsyncLocalStorage<Contexto>();

/** O `resolveScope` típico de um app: passe livre para admin e suporte. */
const resolveSubject = (ctx: Contexto) => ({
  roles: (ctx.user.roles ?? {}) as Roles,
  bypass: ctx.user.admin === true || ctx.user.isSuporte === true || ctx.isSuporte === true,
  attributes: { user: ctx.user, entity: ctx.entity, env: { exercicio: 2026 } },
});

const configure = (overrides: Partial<PermissionsConfig<Contexto, any>> = {}) =>
  configurePermissions<Contexto>({
    catalog: CATALOGO,
    resolveSubject,
    getContext: () => store.getStore(),
    isSameEntity: (ctx) => Number(ctx.user.entidade) === ctx.entity,
    ...overrides,
  });

const inContext = <T>(user: Record<string, unknown>, callback: () => T, isSuporte = false): T =>
  store.run({ user, entity: TENANT, isSuporte }, callback);

const autorizado = {
  id: "user-1",
  entidade: TENANT,
  roles: { [TAG]: { list: true, "trocar-avatar": true } },
};

beforeEach(() => configure());
afterEach(() => resetPermissions());

describe("parseKey", () => {
  test("separa tag e ação", () => {
    expect(parseKey("1:trocar-avatar")).toEqual({ tag: 1, action: "trocar-avatar" });
    expect(parseKey("-30:list")).toEqual({ tag: -30, action: "list" });
  });

  test("chave sem ação devolve ação vazia, que nenhum grant concede", () => {
    expect(parseKey("1")).toEqual({ tag: 1, action: "" });
  });
});

describe("METHOD_TO_ACTION", () => {
  test("verbo HTTP vira ação CRUD", () => {
    expect(METHOD_TO_ACTION).toEqual({
      GET: "list",
      HEAD: "list",
      POST: "create",
      PUT: "edit",
      PATCH: "edit",
      DELETE: "delete",
    });
  });
});

describe("isAuthorized", () => {
  const roles: Roles = { [TAG]: { list: true, "trocar-avatar": true } };
  const ctx: PolicyContext = { user: { id: "user-1" }, entity: TENANT };

  test("sem grant, nega com a mensagem padrão", () => {
    expect(isAuthorized({ tag: TAG, action: "delete", roles, ctx })).toEqual({
      allowed: false,
      reason: DEFAULT_PERMISSION_MESSAGES.denied,
    });
    expect(isAuthorized({ tag: 2, action: "list", roles, ctx }).allowed).toBeFalse();
    expect(isAuthorized({ tag: TAG, action: "list", ctx }).allowed).toBeFalse();
  });

  test("com grant e sem condições, permite", () => {
    expect(isAuthorized({ tag: TAG, action: "list", roles, ctx })).toEqual({ allowed: true });
  });

  test("grant não basta quando a condição do catálogo reprova o recurso", () => {
    const base = { tag: TAG, action: "trocar-avatar", roles, ctx };

    expect(isAuthorized({ ...base, resource: { ownerId: "user-1" } }).allowed).toBeTrue();
    expect(isAuthorized({ ...base, resource: { ownerId: "user-2" } }).allowed).toBeFalse();
  });

  test("o recurso do contexto vale quando a entrada não traz recurso", () => {
    const withRecurso = { ...ctx, resource: { ownerId: "user-1" } };

    expect(
      isAuthorized({ tag: TAG, action: "trocar-avatar", roles, ctx: withRecurso }).allowed,
    ).toBeTrue();
  });

  test("bypass ignora grant e condições", () => {
    expect(
      isAuthorized({ tag: TAG, action: "delete", roles: {}, ctx, bypass: true }).allowed,
    ).toBeTrue();
  });

  test("tag negativa não é considerada: permite sem grant", () => {
    expect(isAuthorized({ tag: -30, action: "delete", roles: {}, ctx }).allowed).toBeTrue();
  });

  test("a mensagem padrão sai da configuração", () => {
    configure({ messages: { denied: "Sem acesso." } });

    expect(isAuthorized({ tag: TAG, action: "delete", roles, ctx }).reason).toBe("Sem acesso.");
  });
});

describe("authorize", () => {
  test("libera quando o grant e a condição do recurso batem", async () => {
    await inContext(autorizado, () =>
      authorize(`${TAG}:trocar-avatar`, { resource: { ownerId: "user-1" } }),
    );
  });

  test("nega com PermissionDeniedError (403, FORBIDDEN) por padrão", async () => {
    const recusa = await inContext(autorizado, () =>
      authorize(`${TAG}:trocar-avatar`, { resource: { ownerId: "user-2" } }),
    ).catch((error: unknown) => error);

    expect(recusa).toBeInstanceOf(PermissionDeniedError);
    expect(recusa).toMatchObject({
      status: 403,
      statusCode: 403,
      code: "FORBIDDEN",
      message: DEFAULT_PERMISSION_MESSAGES.denied,
    });
  });

  test("createForbiddenError troca o erro da negação pelo do app", async () => {
    class ErroDoApp extends Error {}
    configure({ createForbiddenError: (message) => new ErroDoApp(`app: ${message}`) });

    expect(inContext(autorizado, () => authorize(`${TAG}:delete`))).rejects.toThrow(
      new ErroDoApp(`app: ${DEFAULT_PERMISSION_MESSAGES.denied}`),
    );
  });

  test("o check roda depois do grant, recebe args, recurso e os atributos do sujeito", async () => {
    const vistos: unknown[] = [];
    await inContext(autorizado, () =>
      authorize(`${TAG}:list`, {
        args: ["a"],
        resource: { id: 1 },
        check: (context) => {
          vistos.push(context);
          return true;
        },
      }),
    );

    expect(vistos).toEqual([
      {
        args: ["a"],
        resource: { id: 1 },
        user: autorizado,
        entity: TENANT,
        env: { exercicio: 2026 },
      },
    ]);
  });

  test("check que devolve false nega, mesmo com o grant", async () => {
    expect(
      inContext(autorizado, () => authorize(`${TAG}:list`, { check: async () => false })),
    ).rejects.toThrow(PermissionDeniedError);
  });

  test("check não roda quando o grant já negou", async () => {
    let chamado = false;
    const tentativa = inContext(autorizado, () =>
      authorize(`${TAG}:delete`, {
        check: () => {
          chamado = true;
          return true;
        },
      }),
    );

    expect(tentativa).rejects.toThrow(PermissionDeniedError);
    await tentativa.catch(() => undefined);
    expect(chamado).toBeFalse();
  });

  test("bypass da opção libera só o grant: o check continua obrigatório", async () => {
    const withoutGrant = { id: "user-1", entidade: TENANT, roles: {} };
    const check = ({ args, user }: { args: unknown[]; user?: Record<string, unknown> }) =>
      args[0] === user?.id;

    await inContext(withoutGrant, () =>
      authorize(`${TAG}:edit`, { bypass: true, check, args: ["user-1"] }),
    );
    expect(
      inContext(withoutGrant, () => authorize(`${TAG}:edit`, { bypass: true, check, args: ["x"] })),
    ).rejects.toThrow(PermissionDeniedError);
  });

  test("passe livre do sujeito (admin, isSuporte) ignora a matriz", async () => {
    await inContext({ id: "x", roles: {}, admin: true }, () => authorize(`${TAG}:delete`));
    await inContext({ id: "x", roles: {}, isSuporte: true }, () => authorize(`${TAG}:delete`));
    await inContext({ id: "x", roles: {} }, () => authorize(`${TAG}:delete`), true);
  });

  test("tag negativa: qualquer usuário autenticado passa, e o check ainda roda", async () => {
    await inContext({ id: "x", roles: {} }, () => authorize("-30:delete"));
    expect(
      inContext({ id: "x", roles: {} }, () => authorize("-30:delete", { check: () => false })),
    ).rejects.toThrow(PermissionDeniedError);
  });

  test("sujeito não resolvido é não autenticado: nega, tag negativa inclusive", async () => {
    configure({ resolveSubject: () => undefined });

    const recusa = await inContext(autorizado, () => authorize("-30:list")).catch(
      (error: unknown) => error,
    );

    expect(recusa).toBeInstanceOf(PermissionDeniedError);
    expect((recusa as Error).message).toBe(DEFAULT_PERMISSION_MESSAGES.unauthenticated);
  });

  test("resolveSubject recebe o contexto e a tag", async () => {
    const chamadas: unknown[] = [];
    configure({
      resolveSubject: (ctx, tag) => {
        chamadas.push([ctx.entity, tag]);
        return resolveSubject(ctx);
      },
    });

    await inContext(autorizado, () => authorize(`${TAG}:list`));

    expect(chamadas).toEqual([[TENANT, TAG]]);
  });

  test("authorize não confere a entidade (só o isAllowed e a rota)", async () => {
    await inContext({ ...autorizado, entidade: 8 }, () => authorize(`${TAG}:list`));
  });

  describe("fora de uma requisição", () => {
    test("por padrão não bloqueia, como os apps fazem hoje", async () => {
      expect(await authorize(`${TAG}:delete`)).toBeUndefined();
    });

    test("o check não roda fora de requisição", async () => {
      let chamado = false;
      await authorize(`${TAG}:delete`, {
        check: () => {
          chamado = true;
          return false;
        },
      });

      expect(chamado).toBeFalse();
    });

    test('authorizeOutsideRequest: "deny" nega', async () => {
      configure({ authorizeOutsideRequest: "deny" });

      expect(authorize(`${TAG}:list`)).rejects.toThrow(PermissionDeniedError);
    });

    test('authorizeOutsideRequest: "allow" libera', async () => {
      configure({ authorizeOutsideRequest: "allow" });

      expect(await authorize(`${TAG}:list`)).toBeUndefined();
    });
  });
});

describe("isAllowed", () => {
  test("vale a permissão gravada para a tag e a ação", () => {
    const usuario = { entidade: TENANT, roles: { [TAG]: { list: true, edit: false } } };

    expect(inContext(usuario, () => isAllowed(`${TAG}:list`))).toBeTrue();
    expect(inContext(usuario, () => isAllowed(`${TAG}:edit`))).toBeFalse();
    expect(inContext(usuario, () => isAllowed("4:list"))).toBeFalse();
  });

  test("sem permissão nenhuma a resposta é não", () => {
    expect(inContext({ entidade: TENANT }, () => isAllowed(`${TAG}:list`))).toBeFalse();
    expect(inContext({}, () => isAllowed(`${TAG}:list`))).toBeFalse();
  });

  test("administrador e suporte passam sem permissão gravada", () => {
    expect(inContext({ entidade: TENANT, admin: true }, () => isAllowed(`${TAG}:list`))).toBe(true);
    expect(inContext({ entidade: 99, isSuporte: true }, () => isAllowed(`${TAG}:list`))).toBe(true);
    expect(inContext({ entidade: 99 }, () => isAllowed(`${TAG}:list`), true)).toBeTrue();
  });

  test("permissão de outra entidade não vale na entidade do contexto", () => {
    const deOutra = { entidade: 8, roles: { [TAG]: { list: true } } };

    expect(inContext(deOutra, () => isAllowed(`${TAG}:list`))).toBeFalse();
  });

  test("sem isSameEntity, a entidade não é conferida", () => {
    configure({ isSameEntity: undefined });
    const deOutra = { entidade: 8, roles: { [TAG]: { list: true } } };

    expect(inContext(deOutra, () => isAllowed(`${TAG}:list`))).toBeTrue();
  });

  test("tag negativa: qualquer usuário autenticado da entidade pode", () => {
    expect(inContext({ entidade: TENANT }, () => isAllowed("-30:list"))).toBeTrue();
    expect(inContext({ entidade: 8 }, () => isAllowed("-30:list"))).toBeFalse();
  });

  test("sujeito não resolvido é não", () => {
    configure({ resolveSubject: () => undefined });

    expect(inContext(autorizado, () => isAllowed("-30:list"))).toBeFalse();
  });

  test("fora de uma requisição a resposta padrão é não", () => {
    expect(isAllowed(`${TAG}:list`)).toBeFalse();
  });

  test("isAllowedOutsideRequest: true responde sim fora de requisição", () => {
    configure({ isAllowedOutsideRequest: true });

    expect(isAllowed(`${TAG}:list`)).toBeTrue();
  });
});

describe("decideRouteAccess", () => {
  const decide = (user: Record<string, unknown>, action: string, tag = TAG) =>
    decideRouteAccess({ context: { user, entity: TENANT }, tag, action });

  test("com o grant da ação, libera (null)", () => {
    expect(decide(autorizado, "list")).toBeNull();
  });

  test("cada verbo exige a sua ação", () => {
    const usuario = {
      entidade: TENANT,
      roles: { [TAG]: { list: true, create: false, edit: true, delete: false } },
    };
    const decideVerbo = (method: string) => decide(usuario, METHOD_TO_ACTION[method] ?? "");

    expect(decideVerbo("GET")).toBeNull();
    expect(decideVerbo("HEAD")).toBeNull();
    expect(decideVerbo("POST")).toEqual({
      status: 403,
      message: DEFAULT_PERMISSION_MESSAGES.actionDenied.create,
    });
    expect(decideVerbo("PUT")).toBeNull();
    expect(decideVerbo("PATCH")).toBeNull();
    expect(decideVerbo("DELETE")?.status).toBe(403);
    expect(decideVerbo("TRACE")).toEqual({
      status: 403,
      message: DEFAULT_PERMISSION_MESSAGES.denied,
    });
  });

  test("a mensagem de inserir fala em inserir", () => {
    expect(DEFAULT_PERMISSION_MESSAGES.actionDenied.create).toBe(
      "Você não tem permissão para inserir neste recurso.",
    );
  });

  test("usuário de outra entidade recebe 403 da entidade", () => {
    expect(decide({ ...autorizado, entidade: 8 }, "list")).toEqual({
      status: 403,
      message: DEFAULT_PERMISSION_MESSAGES.entityDenied,
    });
  });

  test("passe livre não confere entidade nem matriz", () => {
    expect(decide({ entidade: 99, roles: {}, admin: true }, "delete")).toBeNull();
    expect(decide({ entidade: 99, roles: {}, isSuporte: true }, "create")).toBeNull();
  });

  test("tag negativa libera qualquer autenticado da entidade, com qualquer verbo", () => {
    expect(decide({ entidade: TENANT }, "delete", -30)).toBeNull();
    expect(decide({ entidade: TENANT }, "", -30)).toBeNull();
    expect(decide({ entidade: 8 }, "list", -30)?.status).toBe(403);
  });

  test("sujeito não resolvido responde 401", () => {
    configure({ resolveSubject: () => undefined });

    expect(decide(autorizado, "list")).toEqual({
      status: 401,
      message: DEFAULT_PERMISSION_MESSAGES.unauthenticated,
    });
    expect(decide(autorizado, "list", -30)?.status).toBe(401);
  });

  test("tag que não é inteira responde 500", () => {
    expect(decide(autorizado, "list", Number.NaN)).toEqual({
      status: 500,
      message: DEFAULT_PERMISSION_MESSAGES.invalidTag,
    });
  });

  test("as mensagens são configuráveis, ação por ação", () => {
    configure({
      messages: { entityDenied: "Outra entidade.", actionDenied: { create: "Sem inserir." } },
    });

    expect(decide({ ...autorizado, entidade: 8 }, "list")?.message).toBe("Outra entidade.");
    expect(decide(autorizado, "create")?.message).toBe("Sem inserir.");
    expect(decide(autorizado, "delete")?.message).toBe(
      DEFAULT_PERMISSION_MESSAGES.actionDenied.delete,
    );
  });
});

describe("getContext padrão", () => {
  afterEach(() => setHandlerContext(() => undefined));

  test("sem getContext, lê o contexto do setHandlerContext", () => {
    configure({ getContext: undefined });
    setHandlerContext(() => ({ user: autorizado, entity: TENANT }));

    expect(isAllowed(`${TAG}:list`)).toBeTrue();
    expect(isAllowed(`${TAG}:delete`)).toBeFalse();
  });
});

describe("sem configurePermissions", () => {
  beforeEach(() => resetPermissions());

  test("toda checagem lança um erro que diz o que fazer", async () => {
    const ctx: PolicyContext = {};

    expect(authorize(`${TAG}:list`)).rejects.toThrow("configurePermissions");
    expect(() => isAllowed(`${TAG}:list`)).toThrow("configurePermissions");
    expect(() => isAuthorized({ tag: -1, action: "list", ctx, bypass: true })).toThrow(
      "configurePermissions",
    );
    expect(() => decideRouteAccess({ context: {}, tag: TAG, action: "list" })).toThrow(
      "configurePermissions",
    );
  });

  test("parseKey continua utilizável, porque não decide nada", () => {
    expect(parseKey("1:list")).toEqual({ tag: 1, action: "list" });
  });
});
