/**
 * Modelos de teste que imitam o padrão real da aplicação.
 * Usado por múltiplos arquivos de teste.
 */
import "reflect-metadata";
import {AutoConvert} from "../src/decorators/autoConvert";
import {ModelTagged, getModel} from "../src/decorators/getModel";
import {Field, InitFields, getFieldTypes} from "../src/decorators/initFields";
import {NestedModel} from "../src/decorators/nestedModel";

// ───── BaseModel (padrão igual ao real) ─────

@InitFields
export class BaseModel {
  static tag: number;
  @Field() createdAt!: Date;
  @Field() updatedAt!: Date;
  @Field() enabled!: boolean;
  @Field() entidade!: number;
  @Field() modifiedBy!: string;
  @Field() sequencial!: bigint;
  @Field() active!: boolean;

  constructor() {
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.enabled = true;
    this.entidade = 0;
    this.modifiedBy = "";
    this.sequencial = BigInt(0);
    this.active = true;
  }

  @AutoConvert
  setData(data: Record<string, any>) {
    if (data) {
      const classTag = (this.constructor as typeof BaseModel).tag;
      const modelBase = getModel(classTag);
      if (!modelBase) return;
      const typedKeys = getFieldTypes(modelBase.prototype);
      const keys = Object.keys(typedKeys);
      for (const key of keys) {
        if (key in data) {
          (this as any)[key] = data[key] ?? null;
        }
      }
    }
  }
}

// ───── BairroModel (para nested) ─────

@InitFields
@ModelTagged
export class BairroModel extends BaseModel {
  static tag = 7770;
  static nome = "Bairros";
  @Field() id!: string;
  @Field() name!: string;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new BairroModel();
  }
}

// ───── RuaModel (com NestedModel) ─────

@InitFields
@ModelTagged
export class RuaModel extends BaseModel {
  static tag = 7771;
  static nome = "Ruas";
  @Field() id!: string;
  @Field() name!: string;
  @Field() bairroId!: string;
  @Field() @NestedModel(BairroModel) bairro?: any;
  @Field() cep!: string;
  @Field() tipo!: string;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new RuaModel();
  }
}

// ───── PostModel (usado como nested via @Field) ─────

@InitFields
@ModelTagged
export class PostModel extends BaseModel {
  static tag = 7780;
  static nome = "Posts";
  @Field() id!: string;
  @Field() title!: string;
  @Field("number") views!: number;
  @Field("boolean") published!: boolean;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new PostModel();
  }
}

// ───── ProfileModel (nested to-one via @Field) ─────

@InitFields
@ModelTagged
export class ProfileModel extends BaseModel {
  static tag = 7781;
  static nome = "Profiles";
  @Field() id!: string;
  @Field() bio!: string;
  @Field("number") followers!: number;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new ProfileModel();
  }
}

// ───── UserModel (objetos customizados via @Field) ─────

@InitFields
@ModelTagged
export class UserModel extends BaseModel {
  static tag = 7782;
  static nome = "Users";
  @Field() id!: string;
  @Field() name!: string;
  @Field("number") age!: number;
  // objeto único customizado
  @Field(ProfileModel) profile?: ProfileModel;
  // array de objetos customizados
  @Field([PostModel]) posts?: PostModel[];

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new UserModel();
  }
}

// ─────────────────────────────────────────────────────────────
// Equivalência @NestedModel × @Field(Model)
//
// Dois wrappers apontando para o MESMO model aninhado (BairroModel),
// um declarado via @NestedModel e outro via @Field(Model). O getWhere
// precisa produzir EXATAMENTE o mesmo output para ambos — provando que a
// nova forma (@Field) não altera a montagem do where.
// ─────────────────────────────────────────────────────────────

@InitFields
@ModelTagged
export class WrapperNestedModel extends BaseModel {
  static tag = 7790;
  static nome = "WrapperNested";
  @Field() id!: string;
  @Field() name!: string;
  @Field() @NestedModel(BairroModel) bairro?: any;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new WrapperNestedModel();
  }
}

@InitFields
@ModelTagged
export class WrapperFieldModel extends BaseModel {
  static tag = 7791;
  static nome = "WrapperField";
  @Field() id!: string;
  @Field() name!: string;
  @Field(BairroModel) bairro?: BairroModel;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new WrapperFieldModel();
  }
}

// ─────────────────────────────────────────────────────────────
// Aninhamento profundo (multi-nível) — cadeias paralelas
//
// CountryModel é a folha compartilhada. As cadeias City → State → Country
// são declaradas em duas formas (via @Field e via @NestedModel) usando os
// mesmos nomes de campo, de modo que `state.country.name` resolva igual nas
// duas e o getWhere produza o mesmo where aninhado em 3 níveis.
// ─────────────────────────────────────────────────────────────

@InitFields
@ModelTagged
export class CountryModel extends BaseModel {
  static tag = 7792;
  static nome = "Countries";
  @Field() id!: string;
  @Field() name!: string;
  @Field("number") population!: number;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new CountryModel();
  }
}

// Cadeia via @Field(Model)
@InitFields
@ModelTagged
export class StateFieldModel extends BaseModel {
  static tag = 7793;
  static nome = "StatesField";
  @Field() id!: string;
  @Field() name!: string;
  @Field(CountryModel) country?: CountryModel;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new StateFieldModel();
  }
}

@InitFields
@ModelTagged
export class CityFieldModel extends BaseModel {
  static tag = 7794;
  static nome = "CitiesField";
  @Field() id!: string;
  @Field() name!: string;
  @Field(StateFieldModel) state?: StateFieldModel;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new CityFieldModel();
  }
}

// Cadeia paralela via @NestedModel
@InitFields
@ModelTagged
export class StateNestedModel extends BaseModel {
  static tag = 7795;
  static nome = "StatesNested";
  @Field() id!: string;
  @Field() name!: string;
  @Field() @NestedModel(CountryModel) country?: any;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new StateNestedModel();
  }
}

@InitFields
@ModelTagged
export class CityNestedModel extends BaseModel {
  static tag = 7796;
  static nome = "CitiesNested";
  @Field() id!: string;
  @Field() name!: string;
  @Field() @NestedModel(StateNestedModel) state?: any;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new CityNestedModel();
  }
}

// ─────────────────────────────────────────────────────────────
// Listas aninhadas (to-many) para validar o `some` no getWhere.
//
// - to-one que contém uma lista:   BlogModel.author (to-one) -> author.posts (lista)
// - lista que contém outra lista:  FeedModel.articles (lista) -> articles.tags (lista)
// ─────────────────────────────────────────────────────────────

@InitFields
@ModelTagged
export class AuthorModel extends BaseModel {
  static tag = 7797;
  static nome = "Authors";
  @Field() id!: string;
  @Field() name!: string;
  // lista dentro de um objeto to-one
  @Field([PostModel]) posts?: PostModel[];

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new AuthorModel();
  }
}

@InitFields
@ModelTagged
export class BlogModel extends BaseModel {
  static tag = 7798;
  static nome = "Blogs";
  @Field() id!: string;
  @Field() title!: string;
  @Field(AuthorModel) author?: AuthorModel;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new BlogModel();
  }
}

@InitFields
@ModelTagged
export class TagModel extends BaseModel {
  static tag = 7799;
  static nome = "Tags";
  @Field() id!: string;
  @Field() label!: string;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new TagModel();
  }
}

@InitFields
@ModelTagged
export class ArticleModel extends BaseModel {
  static tag = 7800;
  static nome = "Articles";
  @Field() id!: string;
  @Field() title!: string;
  @Field([TagModel]) tags?: TagModel[];

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new ArticleModel();
  }
}

@InitFields
@ModelTagged
export class FeedModel extends BaseModel {
  static tag = 7801;
  static nome = "Feeds";
  @Field() id!: string;
  // lista que contém outra lista
  @Field([ArticleModel]) articles?: ArticleModel[];

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new FeedModel();
  }
}

// ───── SimpleModel (sem nested, para testes mais simples) ─────

@InitFields
@ModelTagged
export class SimpleModel extends BaseModel {
  static tag = 7772;
  static nome = "Simple";
  @Field() id!: string;
  @Field() name!: string;
  @Field() age!: number;
  @Field() score!: number;
  @Field() isAdmin!: boolean;
  @Field() birthDate!: Date;

  constructor(data?: Record<string, any>) {
    super();
    if (data) this.setData(data);
  }

  static getModel() {
    return new SimpleModel();
  }
}
