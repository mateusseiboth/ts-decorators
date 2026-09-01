import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import "reflect-metadata";

import {
  Field,
  InitFields,
  clearMetadataCache,
  getFieldTypeByKey,
  getFieldTypes,
} from "../src/decorators/initFields";
import { setFreezeMetadata } from "../src/decorators/metadata";
import { getNestedModelMeta } from "../src/decorators/nestedModel";
import { collectFieldMeta } from "../src/functions/collectFieldsTypes";
import { BairroModel, PostModel, ProfileModel, RuaModel, UserModel } from "./_models";

describe("cache de metadata reflexiva", () => {
  beforeEach(() => clearMetadataCache());
  afterEach(() => clearMetadataCache());

  test("getFieldTypes devolve a MESMA referência entre chamadas (memoizado)", () => {
    const first = getFieldTypes(RuaModel.prototype);
    const second = getFieldTypes(RuaModel.prototype);
    expect(second).toBe(first);
  });

  test("por padrão o mapa NÃO é congelado — quem mutava não estoura", () => {
    expect(Object.isFrozen(getFieldTypes(RuaModel.prototype))).toBe(false);
  });

  test("setFreezeMetadata(true) congela e protege o cache de mutação", () => {
    setFreezeMetadata(true);
    clearMetadataCache();
    try {
      const types = getFieldTypes(RuaModel.prototype);
      expect(Object.isFrozen(types)).toBe(true);
      expect(Object.isFrozen(collectFieldMeta(RuaModel.prototype).types)).toBe(true);
      expect(getNestedModelMeta(RuaModel.prototype, "bairro")?.model).toBe(BairroModel);
    } finally {
      setFreezeMetadata(false);
      clearMetadataCache();
    }
  });

  test("o mapa memoizado é COMPARTILHADO — a mesma referência para todo mundo", () => {
    // Não é congelado de propósito: congelar faria estourar em strict mode quem
    // já mutava o retorno. O contrato é "somente leitura", combinado, não imposto.
    const types = getFieldTypes(RuaModel.prototype) as Record<string, string>;
    expect(getFieldTypes(RuaModel.prototype)).toBe(types);
  });

  test("clearMetadataCache força uma nova resolução", () => {
    const first = getFieldTypes(RuaModel.prototype);
    clearMetadataCache();
    const second = getFieldTypes(RuaModel.prototype);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  test("um @Field registrado DEPOIS invalida o cache", () => {
    @InitFields
    class Tardio {
      @Field("string") nome!: string;
    }

    const before = getFieldTypes(Tardio.prototype);
    expect("depois" in before).toBe(false);

    // Simula um registro tardio (mixin, classe montada em runtime).
    Field("number")(Tardio.prototype, "depois");

    const after = getFieldTypes(Tardio.prototype);
    expect(after.depois).toBe("number");
    expect(after).not.toBe(before);
  });

  test("getFieldTypes continua enxergando os campos da superclasse", () => {
    const types = getFieldTypes(RuaModel.prototype);
    expect(types.enabled).toBe("boolean");
    expect(types.name).toBe("string");
  });

  test("getFieldTypeByKey usa o mapa memoizado e mantém a resposta", () => {
    const rua = new RuaModel();
    expect(getFieldTypeByKey(rua, "sequencial")).toBe("bigint");
    expect(getFieldTypeByKey(rua, "inexistente")).toBeUndefined();
  });

  test("getNestedModelMeta memoiza sem perder o resultado", () => {
    const meta1 = getNestedModelMeta(RuaModel.prototype, "bairro");
    const meta2 = getNestedModelMeta(RuaModel.prototype, "bairro");
    expect(meta1?.model).toBe(BairroModel);
    expect(meta2).toBe(meta1);
    expect(getNestedModelMeta(RuaModel.prototype, "name")).toBeUndefined();
  });

  test("collectFieldMeta é memoizado por prototype (sem reinstanciar os nested)", () => {
    const first = collectFieldMeta(RuaModel.prototype);
    const second = collectFieldMeta(RuaModel.prototype);
    expect(second).toBe(first);
    expect(first.types["bairro.name"]).toBe("string");
    expect(first.listPaths.has("bairro")).toBe(false);
  });

  test("collectFieldMeta NUNCA instancia o model aninhado (usa o prototype)", () => {
    let instancias = 0;

    class Filho {
      @Field("string") nome!: string;
      constructor() {
        instancias++;
      }
    }

    @InitFields
    class Pai {
      @Field(Filho) filho!: Filho;
    }

    const meta = collectFieldMeta(Pai.prototype);
    collectFieldMeta(Pai.prototype);
    expect(instancias).toBe(0);
    expect(meta.types["filho.nome"]).toBe("string");
  });

  test("collectFieldMeta com prefixo não usa (nem polui) o cache raiz", () => {
    const raiz = collectFieldMeta(RuaModel.prototype);
    const prefixado = collectFieldMeta(RuaModel.prototype, "rua.");
    expect(prefixado).not.toBe(raiz);
    expect(prefixado.types["rua.name"]).toBe("string");
    expect(collectFieldMeta(RuaModel.prototype)).toBe(raiz);
  });
});

describe("plano de conversão do @AutoConvert", () => {
  beforeEach(() => clearMetadataCache());

  test("é montado uma vez por classe e reaproveitado entre instâncias", async () => {
    const { getConversionPlan } = await import("../src/decorators/autoConvert");
    const plan1 = getConversionPlan(new RuaModel());
    const plan2 = getConversionPlan(new RuaModel());
    expect(plan2).toBe(plan1);
  });

  test("o plano marca como nested só o que veio de @Field(Model)", async () => {
    const { getConversionPlan } = await import("../src/decorators/autoConvert");
    const plan = getConversionPlan(new UserModel());
    expect(plan.has("name")).toBe(true);
    expect(plan.get("profile")?.nested?.model).toBe(ProfileModel);
    expect(plan.get("posts")?.nested).toEqual({
      model: PostModel,
      isArray: true,
      autoConvert: true,
    });
    expect(plan.has("naoExiste")).toBe(false);
  });

  test("@NestedModel puro continua FORA da conversão automática", async () => {
    const { getConversionPlan } = await import("../src/decorators/autoConvert");
    const plan = getConversionPlan(new RuaModel());
    expect(plan.get("bairro")?.nested).toBeUndefined();
    expect(BairroModel.tag).toBe(7770);
  });

  test("converte igual à resolução campo a campo", () => {
    const rua = new RuaModel({ id: "1", name: 10, sequencial: "42", enabled: "N" });
    expect(rua.name).toBe("10");
    expect(rua.sequencial).toBe(BigInt(42));
    expect(rua.enabled).toBe(false);
  });
});
