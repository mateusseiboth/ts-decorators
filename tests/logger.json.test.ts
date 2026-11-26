import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  configureLogger,
  getLogFormat,
  getLogLevel,
  logger,
  resetLogger,
  setLogLevel,
  setLogWriter,
} from "../src/functions/logger";
import { setHandlerContext } from "../src/handlers/context";
import { setOtelLoader } from "../src/observability/otelApi";

const linhas: string[] = [];
const readLinha = (indice = 0): Record<string, any> => JSON.parse(linhas[indice]!);

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

const fakeApi = (traceId: string) => ({
  trace: {
    getActiveSpan: () => ({ spanContext: () => ({ traceId, spanId: SPAN_ID }) }),
  },
});

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const antes = Object.fromEntries(Object.keys(vars).map((chave) => [chave, process.env[chave]]));
  Object.assign(process.env, vars);
  for (const [chave, valor] of Object.entries(vars))
    if (valor === undefined) delete process.env[chave];
  try {
    fn();
  } finally {
    for (const [chave, valor] of Object.entries(antes)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  }
};

describe("logger em JSON", () => {
  beforeEach(() => {
    linhas.length = 0;
    setLogWriter((linha) => void linhas.push(linha));
    configureLogger({ service: "api", env: "production", format: "json", level: "debug" });
  });
  afterEach(() => {
    setLogWriter();
    resetLogger();
    setHandlerContext(() => undefined);
    setOtelLoader();
  });

  test("uma linha por evento, com ts, nível, mensagem, serviço e ambiente", () => {
    logger.info("pronto", { porta: 3000 });

    expect(linhas).toHaveLength(1);
    const linha = readLinha();
    expect(linha).toMatchObject({
      level: "info",
      msg: "pronto",
      service: "api",
      env: "production",
      porta: 3000,
    });
    expect(new Date(linha.ts).toISOString()).toBe(linha.ts);
  });

  test("erro vira err com tipo, mensagem e pilha", () => {
    logger.error("falhou:", new TypeError("sem conexão"));

    const linha = readLinha();
    expect(linha.msg).toBe("falhou:");
    expect(linha.err.type).toBe("TypeError");
    expect(linha.err.message).toBe("sem conexão");
    expect(linha.err.stack).toContain("TypeError");
  });

  test("texto e número soltos entram na mensagem, como no console", () => {
    logger.warn("restam", 3, "jobs");
    expect(readLinha().msg).toBe("restam 3 jobs");
  });

  test("chave sensível é mascarada em qualquer nível do atributo", () => {
    logger.info("login", {
      senha: "123",
      usuario: "ana",
      headers: { authorization: "Bearer x", "x-api-key": "k", accept: "json" },
      lista: [{ refresh_token: "r" }],
    });

    const linha = readLinha();
    expect(linha.senha).toBe("[redacted]");
    expect(linha.usuario).toBe("ana");
    expect(linha.headers).toEqual({
      authorization: "[redacted]",
      "x-api-key": "[redacted]",
      accept: "json",
    });
    expect(linha.lista).toEqual([{ refresh_token: "[redacted]" }]);
  });

  test("o atributo não sobrescreve os campos fixos da linha", () => {
    logger.info("certo", { level: "hack", msg: "outra", service: "x" });
    expect(readLinha()).toMatchObject({ level: "info", msg: "certo", service: "api" });
  });

  test("objeto circular não derruba o log", () => {
    const ciclo: Record<string, unknown> = { nome: "a" };
    ciclo.eu = ciclo;
    logger.info("ciclo", ciclo);
    expect(readLinha().eu).toEqual({ nome: "a", eu: "[circular]" });
  });

  test("trace_id e span_id do span ativo", () => {
    setOtelLoader(() => fakeApi(TRACE_ID));
    logger.info("com trace");
    expect(readLinha()).toMatchObject({ trace_id: TRACE_ID, span_id: SPAN_ID });
  });

  test("span inválido (ids zerados) não entra", () => {
    setOtelLoader(() => fakeApi("0".repeat(32)));
    logger.info("sem trace");
    expect(readLinha().trace_id).toBeUndefined();
  });

  test("request_id, tenant e user_id do contexto do handler", () => {
    setHandlerContext(() => ({ requestId: "r-1", entity: 79, user: { id: "u-9" } }));
    logger.info("no handler");
    expect(readLinha()).toMatchObject({ request_id: "r-1", tenant: 79, user_id: "u-9" });
  });

  test("tenant 0 (contexto ainda sem token) fica de fora", () => {
    setHandlerContext(() => ({ requestId: "r-2", entity: 0 }));
    logger.info("cedo");
    expect(readLinha().tenant).toBeUndefined();
  });

  test("mensagem preguiçosa continua preguiçosa", () => {
    setLogLevel("info");
    let construida = 0;
    logger.debug(() => {
      construida++;
      return "caro";
    });
    expect(construida).toBe(0);
    expect(linhas).toHaveLength(0);
  });

  test("warn e error saem no mesmo formato", () => {
    logger.warn("aviso");
    logger.error("erro");
    expect(linhas.map((linha) => JSON.parse(linha).level)).toEqual(["warn", "error"]);
  });
});

describe("logger legível (pretty)", () => {
  beforeEach(() => {
    linhas.length = 0;
    setLogWriter((linha) => void linhas.push(linha));
    configureLogger({ service: "api", env: "development", format: "pretty", level: "info" });
  });
  afterEach(() => {
    setLogWriter();
    resetLogger();
  });

  test("nível, mensagem e atributos numa linha só, sem JSON", () => {
    logger.info("pronto", { porta: 3000, senha: "x" });
    expect(linhas[0]).toContain("INFO");
    expect(linhas[0]).toContain("pronto");
    expect(linhas[0]).toContain('"porta":3000');
    expect(linhas[0]).toContain('"senha":"[redacted]"');
  });

  test("a pilha do erro vem logo abaixo", () => {
    logger.error("falhou", new Error("quebrou"));
    expect(linhas[0]).toContain("ERROR");
    expect(linhas[0]).toContain("Error: quebrou");
  });
});

describe("configuração por env", () => {
  afterEach(() => resetLogger());

  test("LOG_LEVEL vence o legado TS_COMMONS_LOG_LEVEL", () => {
    withEnv({ LOG_LEVEL: "warn", TS_COMMONS_LOG_LEVEL: "debug" }, () => {
      resetLogger();
      expect(getLogLevel()).toBe("warn");
    });
  });

  test("sem LOG_LEVEL, vale o TS_COMMONS_LOG_LEVEL", () => {
    withEnv({ LOG_LEVEL: undefined, TS_COMMONS_LOG_LEVEL: "debug" }, () => {
      resetLogger();
      expect(getLogLevel()).toBe("debug");
    });
  });

  test("LOG_FORMAT: json em produção, pretty fora, e a env decide quando vem", () => {
    withEnv({ LOG_FORMAT: undefined, DEPLOY_ENV: "production" }, () => {
      resetLogger();
      expect(getLogFormat()).toBe("json");
    });
    withEnv({ LOG_FORMAT: undefined, DEPLOY_ENV: undefined, NODE_ENV: "development" }, () => {
      resetLogger();
      expect(getLogFormat()).toBe("pretty");
    });
    withEnv({ LOG_FORMAT: "json", DEPLOY_ENV: undefined, NODE_ENV: "development" }, () => {
      resetLogger();
      expect(getLogFormat()).toBe("json");
    });
  });
});
