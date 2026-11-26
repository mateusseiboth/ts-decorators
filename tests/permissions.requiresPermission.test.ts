/**
 * `@RequiresPermission`: autoriza `"tag:action"` antes de rodar o método, no legado e no TC39,
 * com método async e leitura da configuração na chamada.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import "reflect-metadata";

import { configurePermissions, resetPermissions } from "../src/permissions/config";
import { PermissionDeniedError } from "../src/permissions/PermissionDeniedError";
import { RequiresPermission } from "../src/permissions/requiresPermission";
import type { CatalogAugmentation, Roles } from "../src/permissions/types";
import { captureWarnings, fakeMethodContext } from "./_helpers";

const TAG = 9941;

const CATALOGO: CatalogAugmentation = {
  [TAG]: {
    label: "Usuários do decorator",
    actions: {
      "trocar-avatar": {
        label: "Trocar avatar",
        conditions: { "resource.ownerId": { ownerId: true } },
      },
      "enviar-boas-vindas": { label: "Enviar boas-vindas" },
      edit: { label: "Editar" },
    },
  },
};

interface Contexto {
  user: Record<string, unknown>;
}

const store = new AsyncLocalStorage<Contexto>();

const configure = () =>
  configurePermissions<Contexto>({
    catalog: CATALOGO,
    getContext: () => store.getStore(),
    resolveSubject: (ctx) => ({
      roles: (ctx.user.roles ?? {}) as Roles,
      bypass: ctx.user.admin === true || ctx.user.isSuporte === true,
      attributes: { user: ctx.user, entity: 7 },
    }),
  });

const inContext = <T>(user: Record<string, unknown>, callback: () => Promise<T>): Promise<T> =>
  store.run({ user }, callback);

const warnCap = captureWarnings();

// Declarada ANTES do configurePermissions: o decorator lê a configuração na chamada.
class Cofre {
  executado = 0;

  @RequiresPermission(`${TAG}:trocar-avatar`, { resource: ([id]) => ({ ownerId: String(id) }) })
  async changeAvatar(id: string): Promise<string> {
    this.executado += 1;
    return `avatar:${id}`;
  }

  @RequiresPermission(`${TAG}:enviar-boas-vindas`, async ({ args }) => args[0] !== "inativo")
  async sendBoasVindas(id: string): Promise<string> {
    this.executado += 1;
    return `boas-vindas:${id}`;
  }

  @RequiresPermission(`${TAG}:edit`, {
    bypass: true,
    check: ({ args, user }) => args[0] === user?.id,
  })
  async editPropriaConta(id: string): Promise<string> {
    this.executado += 1;
    return `conta:${id}`;
  }

  @RequiresPermission(`${TAG}:enviar-boas-vindas`)
  contar(): number {
    this.executado += 1;
    return this.executado;
  }
}

warnCap.restore();

const autorizado = {
  id: "user-1",
  roles: { [TAG]: { "trocar-avatar": true, "enviar-boas-vindas": true } },
};

beforeEach(() => configure());
afterEach(() => resetPermissions());

describe("@RequiresPermission", () => {
  test("libera quando o grant e a condição do recurso batem", async () => {
    const cofre = new Cofre();

    expect(await inContext(autorizado, () => cofre.changeAvatar("user-1"))).toBe("avatar:user-1");
    expect(cofre.executado).toBe(1);
  });

  test("nega e não executa o método quando a condição reprova", async () => {
    const cofre = new Cofre();

    expect(inContext(autorizado, () => cofre.changeAvatar("user-2"))).rejects.toThrow(
      PermissionDeniedError,
    );
    expect(cofre.executado).toBe(0);
  });

  test("nega quando falta o grant, mesmo com a condição satisfeita", async () => {
    const cofre = new Cofre();

    expect(
      inContext({ ...autorizado, roles: {} }, () => cofre.changeAvatar("user-1")),
    ).rejects.toThrow(PermissionDeniedError);
    expect(cofre.executado).toBe(0);
  });

  test("o check assíncrono (atalho: função direta) decide depois do grant", async () => {
    const cofre = new Cofre();

    expect(await inContext(autorizado, () => cofre.sendBoasVindas("ativo"))).toBe(
      "boas-vindas:ativo",
    );
    expect(inContext(autorizado, () => cofre.sendBoasVindas("inativo"))).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  test("bypass libera só o grant: o check custom continua obrigatório", async () => {
    const cofre = new Cofre();
    const withoutGrant = { id: "user-1", roles: {} };

    expect(await inContext(withoutGrant, () => cofre.editPropriaConta("user-1"))).toBe(
      "conta:user-1",
    );
    expect(inContext(withoutGrant, () => cofre.editPropriaConta("user-2"))).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  test("admin e isSuporte passam pelo passe livre do sujeito", async () => {
    const cofre = new Cofre();

    expect(
      await inContext({ id: "x", roles: {}, admin: true }, () => cofre.changeAvatar("user-9")),
    ).toBe("avatar:user-9");
    expect(
      await inContext({ id: "x", roles: {}, isSuporte: true }, () => cofre.changeAvatar("user-9")),
    ).toBe("avatar:user-9");
  });

  test("fora de um request (job, script) a autorização não bloqueia", async () => {
    expect(await new Cofre().changeAvatar("user-9")).toBe("avatar:user-9");
  });

  test("o this do método é a instância", async () => {
    const cofre = new Cofre();
    await inContext(autorizado, () => cofre.sendBoasVindas("ativo"));
    await inContext(autorizado, () => cofre.sendBoasVindas("ativo"));

    expect(cofre.executado).toBe(2);
  });

  test("método síncrono passa a devolver Promise", async () => {
    const cofre = new Cofre();
    const resultado = inContext(autorizado, async () => cofre.contar());

    expect(await resultado).toBe(1);
    // O tipo continua `number`: o decorator legado não muda a assinatura.
    const promessa: unknown = cofre.contar();
    expect(promessa).toBeInstanceOf(Promise);
    expect(await promessa).toBe(2);
  });

  test("sem configurePermissions, a chamada lança um erro claro", async () => {
    resetPermissions();

    expect(new Cofre().changeAvatar("user-1")).rejects.toThrow("configurePermissions");
  });
});

describe("@RequiresPermission: legado e TC39", () => {
  async function carregar(this: { valor: number }, soma: number) {
    return this.valor + soma;
  }

  const isAsyncFunction = (fn: unknown) =>
    typeof fn === "function" && fn.constructor.name === "AsyncFunction";

  test("legado (target, key, descriptor): autoriza e guarda o async e o nome", async () => {
    const descriptor: PropertyDescriptor = { value: carregar, writable: true, configurable: true };
    const cap = captureWarnings();
    const decorado = (
      RequiresPermission(`${TAG}:enviar-boas-vindas`)({}, "carregar", descriptor) ?? descriptor
    ).value as typeof carregar;
    cap.restore();

    expect(isAsyncFunction(decorado)).toBeTrue();
    expect(decorado.name).toBe("carregar");
    expect(await inContext(autorizado, () => decorado.call({ valor: 1 }, 2))).toBe(3);
    expect(inContext({ roles: {} }, () => decorado.call({ valor: 1 }, 2))).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  test("TC39 (method, context): autoriza e devolve AsyncFunction", async () => {
    const decorado = RequiresPermission(`${TAG}:enviar-boas-vindas`)(
      carregar,
      fakeMethodContext("carregar"),
    ) as typeof carregar;

    expect(isAsyncFunction(decorado)).toBeTrue();
    expect(await inContext(autorizado, () => decorado.call({ valor: 10 }, 5))).toBe(15);
    expect(inContext({ roles: {} }, () => decorado.call({ valor: 1 }, 2))).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});
