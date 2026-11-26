import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { configureLogger, resetLogger, setLogWriter } from "../src/functions/logger";
import { patchConsole } from "../src/observability/console";

const linhas: Array<Record<string, any>> = [];
let restore: () => void = () => {};

describe("patchConsole", () => {
  beforeEach(() => {
    linhas.length = 0;
    setLogWriter((linha) => void linhas.push(JSON.parse(linha)));
    configureLogger({ service: "worker", env: "production", format: "json", level: "debug" });
  });
  afterEach(() => {
    restore();
    setLogWriter();
    resetLogger();
  });

  test("console.log/info/warn/error/debug saem no JSON do logger, com o nível certo", () => {
    restore = patchConsole();
    console.log("log", 1);
    console.info("info");
    console.warn("warn");
    console.error("erro", new Error("x"));
    console.debug("debug");

    expect(linhas.map((linha) => [linha.level, linha.msg])).toEqual([
      ["info", "log 1"],
      ["info", "info"],
      ["warn", "warn"],
      ["error", "erro"],
      ["debug", "debug"],
    ]);
    expect(linhas[3]!.err.message).toBe("x");
  });

  test("objeto vira atributo mascarado", () => {
    restore = patchConsole();
    console.info("login", { usuario: "ana", senha: "123" });
    expect(linhas[0]).toMatchObject({ usuario: "ana", senha: "[redacted]" });
  });

  test("o nível do logger filtra o console também", () => {
    configureLogger({ level: "warn" });
    restore = patchConsole();
    console.log("some");
    console.warn("fica");
    expect(linhas.map((linha) => linha.msg)).toEqual(["fica"]);
  });

  test("restore devolve o console original, e ligar duas vezes não empilha", () => {
    const original = console.log;
    restore = patchConsole();
    const segunda = patchConsole();
    segunda();
    restore();
    expect(console.log).toBe(original);
  });

  test("o escritor padrão vai direto ao stdout, sem passar pelo console redirecionado", () => {
    setLogWriter();
    const escritas: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation(
      (texto: string | Uint8Array) => escritas.push(String(texto)) > 0,
    );
    try {
      restore = patchConsole();
      console.log("sem loop");
    } finally {
      spy.mockRestore();
    }
    expect(escritas).toHaveLength(1);
    expect(JSON.parse(escritas[0]!).msg).toBe("sem loop");
  });
});
