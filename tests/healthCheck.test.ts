import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import "reflect-metadata";

import { container } from "../src/decorators/container";
import {
  clearHealthChecks,
  createHealthRouter,
  disposeHealthChecks,
  HealthCheck,
  initHealthChecks,
  registerHealthCheck,
  runHealthChecks,
} from "../src/decorators/healthCheck";
import {
  beginDrain,
  cancelDrain,
  onShutdown,
  resetShutdown,
  runShutdown,
} from "../src/decorators/shutdown";
import { clearQueues } from "../src/queue/registry";
import { captureWarnings } from "./_helpers";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nunca = () => new Promise<never>(() => undefined);

const findCheck = (report: { checks: { name: string }[] }, name: string) =>
  report.checks.find((c) => c.name === name) as any;

describe("runHealthChecks", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    warnCap = captureWarnings();
    clearHealthChecks();
  });
  afterEach(() => {
    warnCap.restore();
    clearHealthChecks();
    container.clear();
  });

  test("sem sondas o relatório é up e vazio", async () => {
    expect(await runHealthChecks()).toEqual({ status: "up", checks: [] });
  });

  test("sonda que resolve é up, e o objeto devolvido vira details", async () => {
    registerHealthCheck("banco", async () => ({ latenciaMs: 3 }));
    registerHealthCheck("cache", () => "ok");

    const report = await runHealthChecks();

    expect(report.status).toBe("up");
    expect(findCheck(report, "banco")).toMatchObject({
      status: "up",
      critical: true,
      details: { latenciaMs: 3 },
    });
    expect(findCheck(report, "cache").status).toBe("up");
    expect(findCheck(report, "cache").details).toBeUndefined();
    expect(findCheck(report, "banco").durationMs).toBeGreaterThanOrEqual(0);
  });

  test("false, exceção, rejeição e prazo estourado deixam a sonda down", async () => {
    registerHealthCheck("falso", () => false, { critical: false });
    registerHealthCheck(
      "lanca",
      () => {
        throw new Error("sem conexão");
      },
      { critical: false },
    );
    registerHealthCheck("rejeita", () => Promise.reject(new Error("recusou")), {
      critical: false,
    });
    registerHealthCheck("lenta", nunca, { critical: false, timeoutMs: 20 });

    const report = await runHealthChecks();

    for (const name of ["falso", "lanca", "rejeita", "lenta"]) {
      expect(findCheck(report, name).status).toBe("down");
      expect(typeof findCheck(report, name).error).toBe("string");
    }
    expect(findCheck(report, "lanca").error).toBe("sem conexão");
    expect(findCheck(report, "rejeita").error).toBe("recusou");
    expect(findCheck(report, "lenta").error).toContain("20");
  });

  test("só a sonda crítica derruba o status", async () => {
    registerHealthCheck("opcional", () => false, { critical: false });
    expect((await runHealthChecks()).status).toBe("up");

    registerHealthCheck("banco", () => false);
    const report = await runHealthChecks();
    expect(report.status).toBe("down");
    expect(findCheck(report, "opcional").critical).toBe(false);
  });

  test("as sondas rodam em paralelo", async () => {
    registerHealthCheck("a", () => delay(50));
    registerHealthCheck("b", () => delay(50));
    registerHealthCheck("c", () => delay(50));

    const inicio = performance.now();
    await runHealthChecks();

    expect(performance.now() - inicio).toBeLessThan(120);
  });

  test("a função devolvida por registerHealthCheck remove a sonda", async () => {
    const remove = registerHealthCheck("removida", () => false);
    remove();
    expect(await runHealthChecks()).toEqual({ status: "up", checks: [] });
  });
});

describe("@HealthCheck", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    warnCap = captureWarnings();
    clearHealthChecks();
    container.clear();
  });
  afterEach(() => {
    warnCap.restore();
    clearHealthChecks();
    container.clear();
  });

  test("legacy: initHealthChecks registra com o nome Classe.metodo e o this da instância", async () => {
    class BancoService {
      latencia = 7;

      @HealthCheck()
      async ping() {
        return { latenciaMs: this.latencia };
      }
    }

    initHealthChecks(new BancoService());
    const report = await runHealthChecks();

    expect(findCheck(report, "BancoService.ping")).toMatchObject({
      status: "up",
      critical: true,
      details: { latenciaMs: 7 },
    });
  });

  test("TC39: o addInitializer registra a sonda quando a instância nasce", async () => {
    const inicializadores: ((this: unknown) => void)[] = [];
    const contexto = {
      kind: "method",
      name: "ping",
      addInitializer: (fn: (this: unknown) => void) => void inicializadores.push(fn),
    };
    class Fila {
      pendentes = 2;
      ping() {
        return { pendentes: this.pendentes };
      }
    }
    HealthCheck()(Reflect.get(Fila.prototype, "ping"), contexto);

    const fila = new Fila();
    for (const init of inicializadores) init.call(fila);

    expect(findCheck(await runHealthChecks(), "Fila.ping")).toMatchObject({
      status: "up",
      details: { pendentes: 2 },
    });
  });

  test("respeita name, critical e timeoutMs", async () => {
    class Integracoes {
      @HealthCheck({ name: "receita-federal", critical: false, timeoutMs: 20 })
      receita() {
        return nunca();
      }
    }

    initHealthChecks(new Integracoes());
    const report = await runHealthChecks();

    expect(report.status).toBe("up");
    expect(findCheck(report, "receita-federal")).toMatchObject({
      status: "down",
      critical: false,
    });
  });

  test("initHealthChecks é idempotente por instância", async () => {
    class Servico {
      @HealthCheck()
      ping() {
        return true;
      }
    }

    const servico = new Servico();
    initHealthChecks(servico);
    initHealthChecks(servico);

    expect((await runHealthChecks()).checks.length).toBe(1);
  });

  test("disposeHealthChecks remove as sondas da instância", async () => {
    class Servico {
      @HealthCheck()
      ping() {
        return true;
      }
    }

    const servico = new Servico();
    initHealthChecks(servico);
    disposeHealthChecks(servico);

    expect((await runHealthChecks()).checks).toEqual([]);
  });

  test("container.get registra e container.clear remove", async () => {
    class CacheService {
      @HealthCheck()
      ping() {
        return true;
      }
    }

    container.get(CacheService);
    expect(findCheck(await runHealthChecks(), "CacheService.ping").status).toBe("up");

    container.clear();
    expect((await runHealthChecks()).checks).toEqual([]);
  });
});

describe("createHealthRouter", () => {
  let warnCap: ReturnType<typeof captureWarnings>;
  let server: Server;
  let base: string;

  const listen = (router: express.Router) => {
    const app = express();
    app.use(router);
    server = app.listen(0);
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  };

  const get = async (rota: string) => {
    const resposta = await fetch(`${base}${rota}`);
    const body: any = await resposta.json();
    return { status: resposta.status, body };
  };

  beforeEach(() => {
    warnCap = captureWarnings();
    clearHealthChecks();
    resetShutdown();
  });
  afterEach(() => {
    warnCap.restore();
    server?.close();
    clearHealthChecks();
    resetShutdown();
    clearQueues();
  });

  test("GET /health responde 200 up, mesmo com sonda crítica down", async () => {
    registerHealthCheck("banco", () => false);
    listen(createHealthRouter());

    expect(await get("/health")).toEqual({ status: 200, body: { status: "up" } });
  });

  test("GET /ready responde 200 com o relatório quando tudo está up", async () => {
    registerHealthCheck("banco", () => ({ conexoes: 2 }));
    listen(createHealthRouter());

    const { status, body } = await get("/ready");

    expect(status).toBe(200);
    expect(body.status).toBe("up");
    expect(body.checks[0]).toMatchObject({ name: "banco", status: "up", details: { conexoes: 2 } });
  });

  test("GET /ready responde 503 quando uma sonda crítica cai", async () => {
    registerHealthCheck("banco", () => false);
    listen(createHealthRouter());

    const { status, body } = await get("/ready");

    expect(status).toBe(503);
    expect(body.status).toBe("down");
  });

  test("GET /ready responde 503 sem rodar sondas durante o desligamento", async () => {
    let rodou = false;
    registerHealthCheck("banco", () => {
      rodou = true;
      return true;
    });
    onShutdown("lento", () => delay(80));
    listen(createHealthRouter());

    const desligamento = runShutdown();
    const ready = await get("/ready");
    const health = await get("/health");
    await desligamento;

    expect(ready).toEqual({
      status: 503,
      body: { status: "down", shuttingDown: true, draining: true },
    });
    expect(health).toEqual({ status: 200, body: { status: "up" } });
    expect(rodou).toBe(false);
  });

  test("GET /ready responde 503 sem rodar sondas durante a drenagem, e volta ao cancelar", async () => {
    let rodou = false;
    registerHealthCheck("banco", () => {
      rodou = true;
      return true;
    });
    listen(createHealthRouter());

    beginDrain();
    const drenando = await get("/ready");
    const health = await get("/health");
    expect(rodou).toBe(false);
    cancelDrain();
    const depois = await get("/ready");

    expect(drenando).toEqual({
      status: 503,
      body: { status: "down", shuttingDown: false, draining: true },
    });
    expect(health.status).toBe(200);
    expect(depois.status).toBe(200);
    expect(rodou).toBe(true);
  });

  test("aceita outros caminhos", async () => {
    listen(createHealthRouter({ livePath: "/vivo", readyPath: "/pronto" }));

    expect((await get("/vivo")).status).toBe(200);
    expect((await get("/pronto")).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(404);
  });
});
