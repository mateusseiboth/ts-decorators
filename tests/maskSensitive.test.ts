import { describe, expect, test } from "bun:test";

import "reflect-metadata";

import { MaskSensitive, applyMask } from "../src/decorators/maskSensitive";
import { clearMetadataCache } from "../src/decorators/metadata";
import { fakeFieldContext } from "./_helpers";

describe("@MaskSensitive", () => {
  test("aplica máscara nos campos marcados via applyMask", () => {
    class User {
      name = "";
      @MaskSensitive() password = "";
      @MaskSensitive({ visible: 4 }) cpf = "";
    }

    const masked = applyMask({ name: "Maria", password: "secret", cpf: "12345678901" }, User);
    expect(masked.name).toBe("Maria");
    expect(masked.password).toBe("******");
    expect(masked.cpf).toBe("*******8901");
  });

  test("não muta o objeto original", () => {
    class User {
      @MaskSensitive() password = "";
    }
    const original = { password: "secret" };
    const masked = applyMask(original, User);
    expect(original.password).toBe("secret");
    expect(masked.password).toBe("******");
  });

  test("@MaskSensitive em método mascara o retorno", async () => {
    class UserController {
      @MaskSensitive() password = "";

      @MaskSensitive()
      async getById() {
        return { password: "secret", name: "Ana" };
      }
    }

    const result = await new UserController().getById();
    expect(result.password).toBe("******");
    expect(result.name).toBe("Ana");
  });

  test("campo marcado no padrão TC39 (Symbol.metadata) também é mascarado", () => {
    // O TypeScript cria esse símbolo ao transpilar decorators TC39; o Bun não
    // traz por padrão, então aqui reproduzimos o mesmo ambiente do consumidor.
    (Symbol as any).metadata ??= Symbol("Symbol.metadata");

    class Token {}
    const metadata: Record<string, any> = {};
    MaskSensitive({ visible: 2 })(undefined, fakeFieldContext("token", metadata));
    (Token as any)[Symbol.metadata] = metadata;

    expect(applyMask({ token: "abcdef" }, Token).token).toBe("****ef");
  });

  test("campo marcado DEPOIS da primeira máscara invalida o cache", () => {
    class Conta {
      @MaskSensitive() senha = "";
    }

    expect(applyMask({ senha: "123", pix: "456" }, Conta)).toEqual({ senha: "***", pix: "456" });

    MaskSensitive()(Conta.prototype, "pix", undefined);
    clearMetadataCache();

    expect(applyMask({ senha: "123", pix: "456" }, Conta)).toEqual({ senha: "***", pix: "***" });
  });
});
