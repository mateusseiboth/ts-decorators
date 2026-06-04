import {beforeEach, describe, expect, test} from "bun:test";
import {clearLegacyWarnings} from "../src/decorators/_proxy";
import {getNestedModelMeta} from "../src/decorators/nestedModel";
import {collectFieldTypes} from "../src/functions/collectFieldsTypes";
import {buildWhereFromQuery, getWhere} from "../src/middlwares/getWhere";
import {mockNext, mockReq, mockRes} from "./_helpers";
import {PostModel, ProfileModel, RuaModel, UserModel} from "./_models";

describe("@Field com objetos customizados (nested)", () => {
  beforeEach(() => clearLegacyWarnings());

  describe("registro de metadata", () => {
    test("@Field(Model) registra relação to-one com autoConvert", () => {
      const meta = getNestedModelMeta(UserModel.prototype, "profile");
      expect(meta?.model).toBe(ProfileModel);
      expect(meta?.isArray).toBe(false);
      expect(meta?.autoConvert).toBe(true);
    });

    test("@Field([Model]) registra relação to-many com autoConvert", () => {
      const meta = getNestedModelMeta(UserModel.prototype, "posts");
      expect(meta?.model).toBe(PostModel);
      expect(meta?.isArray).toBe(true);
      expect(meta?.autoConvert).toBe(true);
    });

    test("@NestedModel puro NÃO ativa autoConvert (retrocompat)", () => {
      const meta = getNestedModelMeta(RuaModel.prototype, "bairro");
      expect(meta?.autoConvert).toBe(false);
    });
  });

  describe("AutoConvert instancia e converte objeto único", () => {
    test("profile vira instância de ProfileModel", () => {
      const user = new UserModel({name: "Ana", profile: {id: "p1", bio: "hi", followers: "42"}});
      expect(user.profile).toBeInstanceOf(ProfileModel);
      // primitivos do nested convertidos seguindo os tipos do ProfileModel
      expect(user.profile!.followers).toBe(42);
      expect(user.profile!.bio).toBe("hi");
    });

    test("profile null permanece null", () => {
      const user = new UserModel({name: "Ana", profile: null});
      expect(user.profile).toBeNull();
    });

    test("instância já existente não é reinstanciada", () => {
      const existing = new ProfileModel({id: "x"});
      const user = new UserModel({name: "Ana", profile: existing});
      expect(user.profile).toBe(existing);
    });
  });

  describe("AutoConvert instancia e converte arrays", () => {
    test("posts vira array de PostModel com tipos convertidos", () => {
      const user = new UserModel({
        name: "Ana",
        posts: [
          {id: "1", title: "A", views: "10", published: "true"},
          {id: "2", title: "B", views: "20", published: "false"},
        ],
      });
      expect(Array.isArray(user.posts)).toBe(true);
      expect(user.posts!.length).toBe(2);
      expect(user.posts![0]).toBeInstanceOf(PostModel);
      expect(user.posts![0]!.views).toBe(10);
      expect(user.posts![0]!.published).toBe(true);
      expect(user.posts![1]!.views).toBe(20);
      expect(user.posts![1]!.published).toBe(false);
    });

    test("valor único em campo de lista é normalizado para array", () => {
      const user = new UserModel({name: "Ana", posts: {id: "1", title: "A", views: "5"}});
      expect(Array.isArray(user.posts)).toBe(true);
      expect(user.posts!.length).toBe(1);
      expect(user.posts![0]!.views).toBe(5);
    });

    test("posts null permanece null", () => {
      const user = new UserModel({name: "Ana", posts: null});
      expect(user.posts).toBeNull();
    });
  });

  describe("compatibilidade com middlewares", () => {
    test("collectFieldTypes expande nested to-one (profile.*) e to-many (posts.*)", () => {
      const fields = collectFieldTypes(new UserModel());
      // diretos
      expect(fields["name"]).toBeDefined();
      expect(fields["profile"]).toBeDefined();
      expect(fields["posts"]).toBeDefined();
      // to-one expandido
      expect(fields["profile.bio"]).toBeDefined();
      expect(fields["profile.followers"]).toBeDefined();
      // to-many também expandido (o getWhere envolve com `some`)
      expect(fields["posts.title"]).toBeDefined();
    });

    test("getWhere monta filtro aninhado para profile.bio", () => {
      const req = mockReq({query: {"profile.bio": "dev"}});
      const res = mockRes();
      const next = mockNext();
      getWhere(req, res, next, UserModel);
      expect(next.called).toBe(true);
      // deve produzir { profile: { bio: { ... } } } em algum nível
      const json = JSON.stringify(res.locals.where);
      expect(json).toContain("profile");
      expect(json).toContain("bio");
    });

    test("buildWhereFromQuery continua funcionando com campos diretos", () => {
      const where = buildWhereFromQuery({name: "Ana", age: "30"}, UserModel);
      expect(where).toBeDefined();
    });
  });
});
