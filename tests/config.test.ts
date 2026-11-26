import { describe, expect, test } from "bun:test";

import { z } from "zod";

import { Config, ConfigError, defineConfig } from "../src/decorators/config";

const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SMTP: z.object({ HOST: z.string() }).optional(),
});

describe("defineConfig", () => {
  test("valida, converte e aplica os defaults", () => {
    const config = defineConfig(EnvSchema, {
      source: { DATABASE_URL: "postgres://db:5432/app", PORT: "8080" },
    });
    expect(config).toEqual({
      DATABASE_URL: "postgres://db:5432/app",
      PORT: 8080,
      LOG_LEVEL: "info",
    });
  });

  test("o resultado não muda depois da subida", () => {
    const config = defineConfig(EnvSchema, { source: { DATABASE_URL: "postgres://db/app" } });
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => ((config as { PORT: number }).PORT = 1)).toThrow();
  });

  test("lista TODOS os problemas de uma vez, pelo nome da variável", () => {
    let error: unknown;
    try {
      defineConfig(EnvSchema, { source: { PORT: "abc", LOG_LEVEL: "verbose" } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const paths = (error as ConfigError).issues.map((issue) => issue.path);
    expect(paths).toEqual(["DATABASE_URL", "PORT", "LOG_LEVEL"]);
    expect((error as ConfigError).message).toStartWith("Configuração inválida:\n- DATABASE_URL: ");
  });

  test("nunca mostra o valor recebido, que pode ser segredo", () => {
    const segredo = "nao-e-uma-url-mas-e-uma-senha-123";
    let message = "";
    try {
      defineConfig(EnvSchema, { source: { DATABASE_URL: segredo } });
    } catch (caught) {
      message = (caught as Error).message + JSON.stringify((caught as ConfigError).issues);
    }
    expect(message).not.toContain(segredo);
  });

  test("caminho aninhado sai com ponto", () => {
    try {
      defineConfig(EnvSchema, { source: { DATABASE_URL: "postgres://db/app", SMTP: {} as any } });
    } catch (caught) {
      expect((caught as ConfigError).issues.map((issue) => issue.path)).toEqual(["SMTP.HOST"]);
      return;
    }
    throw new Error("deveria ter falhado");
  });

  test("sem source lê o process.env", () => {
    process.env.QS_TESTE_CONFIG = "valor";
    const config = defineConfig(z.object({ QS_TESTE_CONFIG: z.string() }));
    delete process.env.QS_TESTE_CONFIG;
    expect(config.QS_TESTE_CONFIG).toBe("valor");
  });

  test("schema que não devolve objeto é erro de uso", () => {
    expect(() =>
      defineConfig(
        z.any().transform(() => 1),
        { source: {} },
      ),
    ).toThrow(/objeto/);
  });
});

describe("@Config", () => {
  test("a classe ganha os valores validados, já na declaração", () => {
    const source = { DATABASE_URL: "postgres://db/app", PORT: "9000" };
    @Config(EnvSchema, { source })
    class AppConfig {
      declare readonly PORT: number;
      declare readonly LOG_LEVEL: string;
    }

    const config = new AppConfig();
    expect(config.PORT).toBe(9000);
    expect(config.LOG_LEVEL).toBe("info");
    expect(() => ((config as { PORT: number }).PORT = 1)).toThrow();
  });

  test("ambiente inválido derruba na declaração da classe, não no primeiro uso", () => {
    expect(() => {
      @Config(EnvSchema, { source: {} })
      class Quebrada {}
      return Quebrada;
    }).toThrow(ConfigError);
  });
});
