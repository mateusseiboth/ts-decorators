/**
 * Cobertura focada na montagem de filtros aninhados (nested) do getWhere.
 *
 * Quando a query traz uma chave com ponto (ex.: `bairro.name=Centro`), o
 * getWhere deve montar o where do Prisma com o objeto aninhado correspondente
 * (ex.: `{ bairro: { name: { equals: "Centro" } } }`).
 *
 * Relações to-one são suportadas tanto via `@NestedModel(Model)` (RuaModel.bairro)
 * quanto via `@Field(Model)` (UserModel.profile). Relações to-many declaradas
 * via `@Field([Model])` (UserModel.posts) NÃO são expandidas — a notação por
 * ponto não é válida para filtros de lista no Prisma — então chaves como
 * `posts.id` são ignoradas.
 */
import {beforeEach, describe, expect, test} from "bun:test";
import {clearLegacyWarnings} from "../src/decorators/_proxy";
import {collectFieldMeta, collectFieldTypes} from "../src/functions/collectFieldsTypes";
import {buildWhereFromQuery, createWhereConditionQuery, getWhere} from "../src/middlwares/getWhere";
import {mockNext, mockReq, mockRes} from "./_helpers";
import {
  BlogModel,
  CityFieldModel,
  CityNestedModel,
  FeedModel,
  RuaModel,
  UserModel,
  WrapperFieldModel,
  WrapperNestedModel,
} from "./_models";

/** Roda o getWhere e devolve o where montado. */
function whereFor(model: any, query: Record<string, any>, customFields?: Record<string, any>) {
  const req = mockReq({query});
  const res = mockRes();
  const next = mockNext();
  getWhere(req, res, next, model, customFields);
  return {where: res.locals.where, next};
}

describe("getWhere - filtros aninhados (nested)", () => {
  beforeEach(() => clearLegacyWarnings());

  describe("relação to-one via @NestedModel (RuaModel.bairro)", () => {
    test("monta objeto aninhado para bairro.name (equals)", () => {
      const {where, next} = whereFor(RuaModel, {"bairro.name": "Centro"});
      expect(next.called).toBe(true);
      expect(where).toEqual({OR: [{bairro: {name: {equals: "Centro"}}}]});
    });

    test("converte tipo do campo aninhado numérico (bairro.entidade)", () => {
      const {where} = whereFor(RuaModel, {"bairro.entidade": "42"});
      expect(where).toEqual({OR: [{bairro: {entidade: {equals: 42}}}]});
    });

    test("operador contains no campo aninhado vira modo insensitive", () => {
      const {where} = whereFor(RuaModel, {"bairro.name": "contains:Cen"});
      expect(where).toEqual({OR: [{bairro: {name: {contains: "Cen", mode: "insensitive"}}}]});
    });

    test("negação (!) no campo aninhado vai para NOT", () => {
      const {where} = whereFor(RuaModel, {"bairro.name": "!Centro"});
      expect(where).toEqual({NOT: [{bairro: {name: {equals: "Centro"}}}]});
    });

    test("múltiplos negativos no campo aninhado agrupam em NOT", () => {
      const {where} = whereFor(RuaModel, {"bairro.name": "!A;!B"});
      expect(where).toEqual({
        NOT: [{bairro: {name: {equals: "A"}}}, {bairro: {name: {equals: "B"}}}],
      });
    });

    test("múltiplos valores (;) no campo aninhado geram múltiplos OR", () => {
      const {where} = whereFor(RuaModel, {"bairro.name": "Centro;Sul"});
      expect(where).toEqual({
        OR: [{bairro: {name: {equals: "Centro"}}}, {bairro: {name: {equals: "Sul"}}}],
      });
    });
  });

  describe("relação to-one via @Field(Model) (UserModel.profile)", () => {
    test("monta objeto aninhado para profile.bio", () => {
      const {where} = whereFor(UserModel, {"profile.bio": "dev"});
      expect(where).toEqual({OR: [{profile: {bio: {equals: "dev"}}}]});
    });

    test("campo aninhado numérico é convertido para Number", () => {
      const {where} = whereFor(UserModel, {"profile.followers": "42"});
      expect(where).toEqual({OR: [{profile: {followers: {equals: 42}}}]});
    });

    test("greaterThan no campo aninhado numérico", () => {
      const {where} = whereFor(UserModel, {"profile.followers": "greaterThan:10"});
      expect(where).toEqual({OR: [{profile: {followers: {gt: 10}}}]});
    });

    test("range numérico no campo aninhado é expandido em OR", () => {
      const {where} = whereFor(UserModel, {"profile.followers": "1-3"});
      expect(where).toEqual({
        OR: [
          {profile: {followers: {equals: 1}}},
          {profile: {followers: {equals: 2}}},
          {profile: {followers: {equals: 3}}},
        ],
      });
    });
  });

  describe("relação to-many via @Field([Model]) (UserModel.posts) usa `some`", () => {
    test("posts.id monta filtro de lista com some (sintaxe Prisma)", () => {
      const {where, next} = whereFor(UserModel, {"posts.id": "1"});
      expect(next.called).toBe(true);
      expect(where).toEqual({OR: [{posts: {some: {id: {equals: "1"}}}}]});
    });

    test("operador contains dentro de some", () => {
      const {where} = whereFor(UserModel, {"posts.title": "contains:hi"});
      expect(where).toEqual({OR: [{posts: {some: {title: {contains: "hi", mode: "insensitive"}}}}]});
    });

    test("campo numérico convertido dentro de some", () => {
      const {where} = whereFor(UserModel, {"posts.views": "greaterThan:5"});
      expect(where).toEqual({OR: [{posts: {some: {views: {gt: 5}}}}]});
    });

    test("negação em campo de lista vai para NOT mantendo some", () => {
      const {where} = whereFor(UserModel, {"posts.id": "!5"});
      expect(where).toEqual({NOT: [{posts: {some: {id: {equals: "5"}}}}]});
    });
  });

  describe("combinação de campos aninhados e diretos", () => {
    test("campo direto + campo aninhado são agrupados em AND", () => {
      const {where} = whereFor(RuaModel, {name: "RuaX", "bairro.id": "1"});
      expect(where.AND).toBeDefined();
      expect(where.AND).toEqual(
        expect.arrayContaining([{OR: [{name: {equals: "RuaX"}}]}, {OR: [{bairro: {id: {equals: "1"}}}]}]),
      );
    });

    test("dois campos aninhados do mesmo pai geram condições AND separadas", () => {
      const {where} = whereFor(RuaModel, {"bairro.id": "1", "bairro.name": "Centro"});
      expect(where.AND).toBeDefined();
      expect(where.AND).toEqual(
        expect.arrayContaining([
          {OR: [{bairro: {id: {equals: "1"}}}]},
          {OR: [{bairro: {name: {equals: "Centro"}}}]},
        ]),
      );
    });

    test("aninhado + customFields combina OR aninhado com AND de customFields", () => {
      const {where} = whereFor(UserModel, {"profile.bio": "dev"}, {active: true});
      expect(where.OR).toEqual([{profile: {bio: {equals: "dev"}}}]);
      expect(where.AND).toEqual([{active: true}]);
    });
  });

  describe("collectFieldTypes - achatamento de relações", () => {
    test("expande relação to-one (@NestedModel) em chaves com ponto", () => {
      const fields = collectFieldTypes(new RuaModel());
      expect(fields["bairro"]).toBe("object");
      expect(fields["bairro.name"]).toBe("string");
      expect(fields["bairro.entidade"]).toBe("number");
    });

    test("expande relação to-one (@Field(Model)) e to-many (@Field([Model]))", () => {
      const fields = collectFieldTypes(new UserModel());
      // to-one expandido
      expect(fields["profile.bio"]).toBe("string");
      expect(fields["profile.followers"]).toBe("number");
      // to-many presente como chave direta E expandido por ponto
      expect(fields["posts"]).toBe("object");
      expect(fields["posts.id"]).toBe("string");
      expect(fields["posts.views"]).toBe("number");
    });

    test("collectFieldMeta registra os dot-paths de relações to-many em listPaths", () => {
      const {listPaths} = collectFieldMeta(new UserModel());
      expect(listPaths.has("posts")).toBe(true);
      // relação to-one não entra em listPaths
      expect(listPaths.has("profile")).toBe(false);
    });
  });

  describe("createWhereConditionQuery com chave aninhada (dot key)", () => {
    test("monta objeto aninhado a partir da chave com ponto", () => {
      const result = createWhereConditionQuery("Centro", "bairro.name", {"bairro.name": "string"});
      expect(result.OR).toEqual([{bairro: {name: {equals: "Centro"}}}]);
      expect(result.NOT).toEqual([]);
    });

    test("chave com múltiplos níveis aninha na ordem correta", () => {
      const result = createWhereConditionQuery("x", "a.b.c", {"a.b.c": "string"});
      expect(result.OR).toEqual([{a: {b: {c: {equals: "x"}}}}]);
    });
  });

  describe("equivalência @NestedModel × @Field(Model)", () => {
    // Mesmas queries, dois wrappers apontando para o MESMO BairroModel.
    // O output do getWhere deve ser IDÊNTICO — garante que a nova forma
    // @Field(Model) não muda a montagem do where em relação ao @NestedModel.
    const queries: Array<[string, Record<string, any>]> = [
      ["equals", {"bairro.name": "Centro"}],
      ["contains", {"bairro.name": "contains:Cen"}],
      ["numérico", {"bairro.entidade": "42"}],
      ["greaterThan", {"bairro.entidade": "greaterThan:5"}],
      ["negação", {"bairro.name": "!Centro"}],
      ["múltiplos OR", {"bairro.name": "Centro;Sul"}],
      ["aninhado + direto", {name: "RuaX", "bairro.name": "Centro"}],
    ];

    for (const [label, query] of queries) {
      test(`output idêntico para "${label}"`, () => {
        const nested = whereFor(WrapperNestedModel, query).where;
        const field = whereFor(WrapperFieldModel, query).where;
        expect(field).toEqual(nested);
      });
    }

    test("collectFieldTypes achata os mesmos campos nas duas formas", () => {
      const nested = collectFieldTypes(new WrapperNestedModel());
      const field = collectFieldTypes(new WrapperFieldModel());
      expect(Object.keys(field).sort()).toEqual(Object.keys(nested).sort());
      expect(field["bairro.name"]).toBe(nested["bairro.name"]);
    });
  });

  describe("aninhamento profundo (multi-nível, 3 níveis)", () => {
    test("@Field encadeado monta where aninhado em 3 níveis (state.country.name)", () => {
      const {where} = whereFor(CityFieldModel, {"state.country.name": "Brasil"});
      expect(where).toEqual({OR: [{state: {country: {name: {equals: "Brasil"}}}}]});
    });

    test("campo numérico no 3º nível com operador (state.country.population)", () => {
      const {where} = whereFor(CityFieldModel, {"state.country.population": "greaterThan:100"});
      expect(where).toEqual({OR: [{state: {country: {population: {gt: 100}}}}]});
    });

    test("nível intermediário também filtra (state.name)", () => {
      const {where} = whereFor(CityFieldModel, {"state.name": "SP"});
      expect(where).toEqual({OR: [{state: {name: {equals: "SP"}}}]});
    });

    test("@Field e @NestedModel encadeados produzem o MESMO where profundo", () => {
      const query = {"state.country.name": "Brasil"};
      const field = whereFor(CityFieldModel, query).where;
      const nested = whereFor(CityNestedModel, query).where;
      expect(field).toEqual(nested);
      expect(field).toEqual({OR: [{state: {country: {name: {equals: "Brasil"}}}}]});
    });

    test("collectFieldTypes expande as mesmas chaves profundas nas duas cadeias", () => {
      const field = collectFieldTypes(new CityFieldModel());
      const nested = collectFieldTypes(new CityNestedModel());
      expect(Object.keys(field).sort()).toEqual(Object.keys(nested).sort());
      expect(field["state.country.name"]).toBe("string");
      expect(field["state.country.population"]).toBe("number");
    });
  });

  describe("listas aninhadas em profundidade (Prisma `some` encadeado)", () => {
    test("to-one contendo lista: author.posts.title -> author.posts.some", () => {
      const {where} = whereFor(BlogModel, {"author.posts.title": "Hello"});
      expect(where).toEqual({OR: [{author: {posts: {some: {title: {equals: "Hello"}}}}}]});
    });

    test("lista contendo lista: articles.tags.label -> some encadeado", () => {
      const {where} = whereFor(FeedModel, {"articles.tags.label": "js"});
      expect(where).toEqual({OR: [{articles: {some: {tags: {some: {label: {equals: "js"}}}}}}]});
    });

    test("listPaths captura os caminhos to-many em cada nível", () => {
      expect([...collectFieldMeta(new BlogModel()).listPaths]).toEqual(["author.posts"]);
      expect([...collectFieldMeta(new FeedModel()).listPaths].sort()).toEqual(["articles", "articles.tags"]);
    });
  });

  describe("validação: campos inexistentes nos models são rejeitados", () => {
    // O getWhere só itera sobre as chaves achatadas REAIS do model
    // (collectFieldMeta), então uma chave de query que não corresponde a um
    // campo existente nunca entra no where — protege contra colunas inválidas
    // no Prisma.
    test("campo direto inexistente é ignorado", () => {
      const {where} = whereFor(UserModel, {nonexistent: "x"});
      expect(where).toEqual({});
    });

    test("campo to-one inexistente (profile.fake) é ignorado", () => {
      const {where} = whereFor(UserModel, {"profile.fake": "x"});
      expect(where).toEqual({});
    });

    test("campo to-many inexistente (posts.fake) é ignorado", () => {
      const {where} = whereFor(UserModel, {"posts.fake": "x"});
      expect(where).toEqual({});
    });

    test("caminho aninhado inexistente em profundidade (state.country.fake) é ignorado", () => {
      const {where} = whereFor(CityFieldModel, {"state.country.fake": "x"});
      expect(where).toEqual({});
    });

    test("relação inexistente como prefixo (fake.name) é ignorada", () => {
      const {where} = whereFor(RuaModel, {"fake.name": "x"});
      expect(where).toEqual({});
    });

    test("campo válido + campo inexistente: só o válido entra no where", () => {
      const {where} = whereFor(UserModel, {name: "Ana", "posts.fake": "x"});
      expect(where).toEqual({OR: [{name: {equals: "Ana"}}]});
    });

    test("campos inexistentes não aparecem entre as chaves achatadas", () => {
      const {types} = collectFieldMeta(new UserModel());
      expect(types["posts.fake"]).toBeUndefined();
      expect(types["profile.fake"]).toBeUndefined();
      expect(types["nonexistent"]).toBeUndefined();
    });
  });

  describe("buildWhereFromQuery com valor objeto (relação aninhada já montada)", () => {
    test("valor objeto é repassado diretamente para o where", () => {
      const where = buildWhereFromQuery({bairro: {name: "Centro"}}, RuaModel);
      expect(where).toEqual({bairro: {name: "Centro"}});
    });

    test("chave com ponto NÃO é reconhecida (getFieldTypes não achata) - where vazio", () => {
      const where = buildWhereFromQuery({"bairro.name": "Centro"}, RuaModel);
      expect(where).toEqual({});
    });
  });
});
