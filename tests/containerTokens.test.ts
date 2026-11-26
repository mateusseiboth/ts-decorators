import "reflect-metadata";
import { describe, expect, test } from "bun:test";

import { container, createContainer, createToken, Inject } from "../src/decorators/container";
import { Injectable } from "../src/decorators/Injectable";

interface Relogio {
  agora(): number;
}

const RELOGIO = createToken<Relogio>("Relogio");

@Injectable()
class Agenda {
  constructor(@Inject(RELOGIO) readonly relogio: Relogio) {}
}

describe("container: token que não é classe", () => {
  test("register e get por token tipado", () => {
    const c = createContainer();
    const fixo: Relogio = { agora: () => 42 };
    c.register(RELOGIO, fixo);
    const relogio: Relogio = c.get(RELOGIO);
    expect(relogio.agora()).toBe(42);
  });

  test("@Inject(token) resolve o parâmetro do construtor pelo token", () => {
    const c = createContainer();
    c.register(RELOGIO, { agora: () => 7 });
    expect(c.get(Agenda).relogio.agora()).toBe(7);
  });

  test("token sem registro falha com o nome do token", () => {
    expect(() => createContainer().get(RELOGIO)).toThrow("Relogio");
  });

  test("token de texto também serve", () => {
    const c = createContainer();
    const URL_DA_API = createToken<string>("URL_DA_API");
    c.register(URL_DA_API, "https://api.exemplo");
    expect(c.get(URL_DA_API)).toBe("https://api.exemplo");
  });
});

describe("container por app", () => {
  @Injectable()
  class Contador {
    valor = 0;
  }

  test("cada container tem as próprias instâncias, sem tocar no global", () => {
    const a = createContainer();
    const b = createContainer();
    a.get(Contador).valor = 5;
    expect(b.get(Contador).valor).toBe(0);
    expect(a.get(Contador)).not.toBe(container.get(Contador));
  });
});
