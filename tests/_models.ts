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
