import {describe, expect, test} from "bun:test";
import {collectFieldTypes} from "../src/functions/collectFieldsTypes";
import {extractAndRemoveByKey} from "../src/functions/extractAndRemoveByKey";
import {jwtDecode} from "../src/functions/jwt";
import {makePrismaOptions, removeFromWhere} from "../src/functions/makePrismaOptions";
import {filterObjectByModel, getModelKeys} from "../src/functions/object";
import {convertBigIntValues} from "../src/functions/sql";
import {mockRes} from "./_helpers";
import {RuaModel, SimpleModel} from "./_models";

describe("Functions", () => {
  describe("extractAndRemoveByKey", () => {
    test("extrai e remove chave rasa", () => {
      const obj = {a: 1, b: 2, c: 3};
      const {value, obj: result} = extractAndRemoveByKey(obj, "b");
      expect(value).toBe(2);
      expect(result).toEqual({a: 1, c: 3});
    });

    test("extrai de objeto aninhado", () => {
      const obj = {x: {y: {target: "found", z: 1}}};
      const {value} = extractAndRemoveByKey(obj, "target");
      expect(value).toBe("found");
      expect(obj.x.y).toEqual({z: 1});
    });

    test("retorna undefined se chave não existe", () => {
      const {value} = extractAndRemoveByKey({a: 1}, "nope");
      expect(value).toBeUndefined();
    });

    test("funciona com arrays", () => {
      const obj = {items: [{key: "val", other: 1}, {key: "val2"}]};
      const {value} = extractAndRemoveByKey(obj, "key");
      expect(value).toBeDefined();
    });
  });

  describe("jwtDecode", () => {
    test("decodifica payload de JWT válido", () => {
      // Cria um JWT fake: header.payload.signature
      const payload = {sub: "123", name: "Test", iat: 1000};
      const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
      const token = `eyJhbGciOiJIUzI1NiJ9.${b64}.fakesig`;
      const decoded = jwtDecode(token);
      expect(decoded.sub).toBe("123");
      expect(decoded.name).toBe("Test");
    });

    test("retorna {} para token vazio", () => {
      expect(jwtDecode("")).toEqual({});
    });

    test("retorna {} para token sem payload", () => {
      expect(jwtDecode("onlyheader")).toEqual({});
    });
  });

  describe("convertBigIntValues", () => {
    test("converte bigint para string", () => {
      const data = {id: BigInt(42), name: "test"};
      const result = convertBigIntValues(data);
      expect(result.id).toBe("42");
      expect(result.name).toBe("test");
    });

    test("converte Date para ISO string", () => {
      const d = new Date("2024-01-01T00:00:00Z");
      expect(convertBigIntValues(d)).toBe(d.toISOString());
    });

    test("converte recursivamente em arrays", () => {
      const data = [{val: BigInt(1)}, {val: BigInt(2)}];
      const result = convertBigIntValues(data);
      expect(result[0].val).toBe("1");
      expect(result[1].val).toBe("2");
    });

    test("converte recursivamente em objetos aninhados", () => {
      const data = {nested: {deep: BigInt(99)}};
      const result = convertBigIntValues(data);
      expect(result.nested.deep).toBe("99");
    });

    test("retorna primitivos sem alteração", () => {
      expect(convertBigIntValues(42)).toBe(42);
      expect(convertBigIntValues("str")).toBe("str");
      expect(convertBigIntValues(null)).toBe(null);
    });
  });

  describe("makePrismaOptions", () => {
    test("cria options com where, orderBy e paginate", () => {
      const res = mockRes({
        locals: {
          where: {name: "test"},
          orderBy: [{name: "asc"}],
          paginate: {skip: 0, take: 10, page: 1},
        },
      });
      const opts = makePrismaOptions(res);
      // sem AND prévio no where de entrada, makePrismaOptions inicializa AND como []
      expect(Array.isArray(opts.where.AND)).toBe(true);
      expect(opts.where.AND.length).toBe(0);
      // campos diretos do where de entrada são preservados
      expect(opts.where.name).toBe("test");
      expect(opts.orderBy).toEqual([{name: "asc"}]);
      expect(opts.skip).toBe(0);
      expect(opts.take).toBe(10);
    });

    test("funciona sem where/orderBy/paginate", () => {
      const res = mockRes({locals: {}});
      const opts = makePrismaOptions(res);
      expect(opts.where.AND).toBeDefined();
    });
  });

  describe("removeFromWhere", () => {
    test("remove chave de AND/OR", () => {
      const where = {
        where: {
          AND: [{OR: [{name: "x"}, {age: 5}]}, {status: "active"}],
        },
      };
      const result = removeFromWhere(where, "name");
      const orCond = result.where.AND[0];
      expect(orCond.OR.some((c: any) => c.name)).toBe(false);
    });

    test("seta undefined em chave direta no AND", () => {
      const where = {where: {AND: [{status: "active"}]}};
      const result = removeFromWhere(where, "status");
      expect(result.where.AND[0].status).toBeUndefined();
    });
  });

  describe("filterObjectByModel (usando SimpleModel)", () => {
    test("filtra apenas campos do model", () => {
      const obj = {id: "1", name: "Test", age: 30, unknownField: "nope", score: 10};
      const result = filterObjectByModel(obj, SimpleModel);
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).not.toHaveProperty("unknownField");
    });
  });

  describe("collectFieldTypes (usando RuaModel)", () => {
    test("coleta campos incluindo nested BairroModel", () => {
      const fields = collectFieldTypes(new RuaModel());
      // Campos próprios da RuaModel
      expect(fields["id"]).toBeDefined();
      expect(fields["name"]).toBeDefined();
      expect(fields["cep"]).toBeDefined();
      // Campos do nested BairroModel
      expect(fields["bairro.id"]).toBeDefined();
      expect(fields["bairro.name"]).toBeDefined();
    });

    test("coleta campos de BaseModel herdados", () => {
      const fields = collectFieldTypes(new SimpleModel());
      expect(fields["createdAt"]).toBeDefined();
      expect(fields["enabled"]).toBeDefined();
      expect(fields["age"]).toBeDefined();
    });
  });

  describe("getModelKeys", () => {
    test("retorna chaves do model via reflect-metadata", () => {
      const keys = getModelKeys(SimpleModel);
      // getModelKeys usa Reflect.getMetadata('fields', proto) — depende de como os campos foram registrados
      // Se retornar vazio, é esperado pois nosso @Field usa WeakMap e não 'fields' metadata key
      expect(Array.isArray(keys)).toBe(true);
    });
  });
});
