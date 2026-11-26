/**
 * Catálogo de permissões: descoberta dos Models (`@ModelTagged`) somada à agregação do app.
 * Catálogo de permissões: recursos, ações e tags.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import "reflect-metadata";

import { ModelTagged } from "../src/decorators/getModel";
import { getActionDef, getPermissionCatalog, resetCatalogCache } from "../src/permissions/catalog";
import { configurePermissions, resetPermissions } from "../src/permissions/config";
import type { CatalogAugmentation, PermissionsConfig } from "../src/permissions/types";
import { captureWarnings } from "./_helpers";

const warnCap = captureWarnings();

@ModelTagged
class EmpenhoCatalogoModel {
  static tag = 4201;
  static nome = "Empenhos";
}

@ModelTagged
class ContaCatalogoModel {
  static tag = 4202;
  static nome = "Contas";
}

@ModelTagged
class RelatorioCatalogoModel {
  static tag = -4201;
  static nome = "Relatórios";
}

@ModelTagged
class SemNomeCatalogoModel {
  static tag = 4203;
}

warnCap.restore();

const CATALOGO: CatalogAugmentation = {
  4202: {
    actions: {
      "trocar-avatar": {
        label: "Trocar avatar",
        conditions: { "resource.ownerId": { ownerId: true } },
      },
      desativar: { label: "Desativar" },
    },
  },
  9921: { label: "Catálogo de Permissões", actions: { consultar: { label: "Consultar" } } },
  [-4201]: { actions: { exportar: { label: "Exportar" } } },
  [-9921]: { label: "Negativa custom", actions: { ver: { label: "Ver" } } },
};

const configure = (overrides: Partial<PermissionsConfig<unknown, any>> = {}) =>
  configurePermissions({
    catalog: CATALOGO,
    resolveSubject: () => ({ roles: {}, bypass: false }),
    ...overrides,
  });

const resourceOf = (tag: number) => getPermissionCatalog().find((entry) => entry.tag === tag);

const actionsOf = (tag: number) =>
  (resourceOf(tag)?.actions ?? []).map((action) => action.action).sort();

beforeEach(() => configure());
afterEach(() => resetPermissions());

describe("catálogo: descoberta dos Models + agregação", () => {
  test("Model descoberto herda o CRUD e o rótulo vem do próprio Model", () => {
    expect(EmpenhoCatalogoModel.tag).toBe(4201);
    expect(resourceOf(4201)).toMatchObject({ label: "Empenhos", custom: false });
    expect(actionsOf(4201)).toEqual(["create", "delete", "edit", "list"]);
    expect(resourceOf(4201)?.actions.find((action) => action.action === "create")?.label).toBe(
      "Inserir",
    );
  });

  test("agregação soma ações não CRUD à tag do Model sem apagar o CRUD", () => {
    expect(ContaCatalogoModel.tag).toBe(4202);
    expect(resourceOf(4202)).toMatchObject({ label: "Contas", custom: false });
    expect(actionsOf(4202)).toEqual([
      "create",
      "delete",
      "desativar",
      "edit",
      "list",
      "trocar-avatar",
    ]);
  });

  test("tag custom não tem Model nem CRUD implícito", () => {
    expect(resourceOf(9921)).toMatchObject({ label: "Catálogo de Permissões", custom: true });
    expect(actionsOf(9921)).toEqual(["consultar"]);
  });

  test("Model sem nome não vira recurso", () => {
    expect(SemNomeCatalogoModel.tag).toBe(4203);
    expect(resourceOf(4203)).toBeUndefined();
  });

  test("tag negativa nunca aparece no catálogo, nem por Model nem pela agregação", () => {
    expect(RelatorioCatalogoModel.tag).toBe(-4201);
    expect(resourceOf(-4201)).toBeUndefined();
    expect(resourceOf(-9921)).toBeUndefined();
    expect(getPermissionCatalog().filter((resource) => resource.tag < 0)).toEqual([]);
    expect(getActionDef(-4201, "list")).toBeUndefined();
  });

  test("tag custom sem label lança, porque não há Model para dar o nome", () => {
    configure({ catalog: { 9922: { actions: { ver: { label: "Ver" } } } } });

    expect(() => getPermissionCatalog()).toThrow("9922");
  });

  test("tag do catálogo sem Model e abaixo de CUSTOM_TAG_MIN avisa: as condições não valeriam", () => {
    configure({ catalog: { ...CATALOGO, 4299: { actions: { ver: { label: "Ver" } } } } });
    const cap = captureWarnings();
    getPermissionCatalog();
    cap.restore();

    expect(resourceOf(4299)).toBeUndefined();
    expect(cap.warnings.join("\n")).toContain("4299");
    expect(cap.warnings.join("\n")).not.toContain("4202");
    expect(cap.warnings.join("\n")).not.toContain("-4201");
  });

  test("getActionDef expõe as condições ABAC declaradas", () => {
    expect(getActionDef(4202, "trocar-avatar")).toMatchObject({
      hasConditions: true,
      conditions: { "resource.ownerId": { ownerId: true } },
    });
    expect(getActionDef(4202, "list")?.hasConditions).toBeFalse();
    expect(getActionDef(4202, "list")?.conditions).toBeUndefined();
    expect(getActionDef(4202, "inexistente")).toBeUndefined();
  });

  test("describeResource soma campos do app a cada recurso", () => {
    configure({
      describeResource: (resource) => ({ module: resource.tag >= 9000 ? "comuns" : "financeiro" }),
    });

    expect(getPermissionCatalog<{ module: string }>().find((r) => r.tag === 4201)?.module).toBe(
      "financeiro",
    );
    expect(getPermissionCatalog<{ module: string }>().find((r) => r.tag === 9921)?.module).toBe(
      "comuns",
    );
  });
});

describe("memoização", () => {
  test("a segunda chamada devolve o mesmo catálogo", () => {
    expect(getPermissionCatalog()).toBe(getPermissionCatalog());
  });

  test("resetCatalogCache refaz o catálogo", () => {
    const antes = getPermissionCatalog();
    resetCatalogCache();

    expect(getPermissionCatalog()).not.toBe(antes);
    expect(getPermissionCatalog()).toEqual(antes);
  });

  test("configurar de novo descarta o catálogo da configuração anterior", () => {
    expect(resourceOf(9921)).toBeDefined();
    configure({ catalog: {} });

    expect(resourceOf(9921)).toBeUndefined();
  });
});

describe("sem configurePermissions", () => {
  test("o catálogo lança um erro que diz o que fazer", () => {
    resetPermissions();

    expect(() => getPermissionCatalog()).toThrow("configurePermissions");
    expect(() => getActionDef(4201, "list")).toThrow("configurePermissions");
  });
});
