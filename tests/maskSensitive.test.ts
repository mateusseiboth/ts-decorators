import {describe, expect, test} from "bun:test";
import "reflect-metadata";
import {MaskSensitive, applyMask} from "../src/decorators/maskSensitive";

describe("@MaskSensitive", () => {
  test("aplica máscara nos campos marcados via applyMask", () => {
    class User {
      name = "";
      @MaskSensitive() password = "";
      @MaskSensitive({visible: 4}) cpf = "";
    }

    const masked = applyMask({name: "Maria", password: "secret", cpf: "12345678901"}, User);
    expect(masked.name).toBe("Maria");
    expect(masked.password).toBe("******");
    expect(masked.cpf).toBe("*******8901");
  });

  test("não muta o objeto original", () => {
    class User {
      @MaskSensitive() password = "";
    }
    const original = {password: "secret"};
    const masked = applyMask(original, User);
    expect(original.password).toBe("secret");
    expect(masked.password).toBe("******");
  });

  test("@MaskSensitive em método mascara o retorno", async () => {
    class UserController {
      @MaskSensitive() password = "";

      @MaskSensitive()
      async getById() {
        return {password: "secret", name: "Ana"};
      }
    }

    const result = await new UserController().getById();
    expect(result.password).toBe("******");
    expect(result.name).toBe("Ana");
  });
});
