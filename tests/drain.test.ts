import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { createDrainRouter, rejectWritesWhenDraining } from "../src/decorators/drain";
import {
  beginDrain,
  cancelDrain,
  getDrainStatus,
  isDraining,
  isShuttingDown,
  onShutdown,
  resetShutdown,
  runShutdown,
} from "../src/decorators/shutdown";
import { InMemoryQueueAdapter } from "../src/queue/InMemoryQueueAdapter";
import {
  clearQueues,
  enqueue,
  getInFlightCount,
  isProcessingPaused,
  registerProcessor,
  registerQueue,
  startProcessors,
} from "../src/queue/registry";
import { captureWarnings } from "./_helpers";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Um job que fica em voo até `libera()` ser chamado. */
async function holdJob(fila: string): Promise<() => void> {
  let libera: () => void = () => undefined;
  const preso = new Promise<void>((resolve) => {
    libera = resolve;
  });
  registerQueue(fila, new InMemoryQueueAdapter());
  registerProcessor(fila, { handler: () => preso, concurrency: 1, pollMs: 5 });
  startProcessors();
  await enqueue(fila, { id: 1 });
  while (getInFlightCount() === 0) await delay(2);
  return libera;
}

describe("estado de drenagem", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    warnCap = captureWarnings();
    resetShutdown();
  });
  afterEach(() => {
    warnCap.restore();
    resetShutdown();
    clearQueues();
  });

  test("começa desligado, com o status ok", () => {
    expect(isDraining()).toBe(false);
    expect(getDrainStatus()).toEqual({
      status: "ok",
      draining: false,
      activeJobs: 0,
      ready: false,
    });
  });

  test("beginDrain liga o estado e pausa as filas", () => {
    beginDrain();

    expect(isDraining()).toBe(true);
    expect(isProcessingPaused()).toBe(true);
    expect(getDrainStatus()).toEqual({
      status: "draining",
      draining: true,
      activeJobs: 0,
      ready: true,
    });
  });

  test("ready só fica true quando não há job em voo", async () => {
    const libera = await holdJob("drain-ready");
    beginDrain();

    expect(getDrainStatus()).toMatchObject({ draining: true, activeJobs: 1, ready: false });
    libera();
    while (getInFlightCount() > 0) await delay(2);
    expect(getDrainStatus()).toMatchObject({ draining: true, activeJobs: 0, ready: true });
  });

  test("beginDrain é idempotente", () => {
    beginDrain();
    beginDrain();
    cancelDrain();

    expect(isDraining()).toBe(false);
    expect(isProcessingPaused()).toBe(false);
  });

  test("cancelDrain desliga o estado e retoma as filas", () => {
    beginDrain();
    cancelDrain();

    expect(isDraining()).toBe(false);
    expect(isProcessingPaused()).toBe(false);
    expect(getDrainStatus().status).toBe("ok");
  });

  test("cancelDrain sem drenagem não mexe nas filas", () => {
    cancelDrain();
    expect(isDraining()).toBe(false);
    expect(isProcessingPaused()).toBe(false);
  });

  test("cancelDrain não faz nada durante o desligamento", async () => {
    onShutdown("lento", () => delay(50));
    const desligamento = runShutdown();
    await delay(5);

    cancelDrain();

    expect(isShuttingDown()).toBe(true);
    expect(isDraining()).toBe(true);
    expect(isProcessingPaused()).toBe(true);
    await desligamento;
  });

  test("resetShutdown zera o estado de drenagem", () => {
    beginDrain();
    resetShutdown();
    expect(isDraining()).toBe(false);
  });
});

describe("rejectWritesWhenDraining", () => {
  let warnCap: ReturnType<typeof captureWarnings>;
  let server: Server;
  let base: string;

  const listen = (options?: Parameters<typeof rejectWritesWhenDraining>[0]) => {
    const app = express();
    app.use(rejectWritesWhenDraining(options));
    app.all("/recurso", (req, res) => {
      res.json({ ok: true, method: req.method });
    });
    server = app.listen(0);
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  };

  const send = async (method: string) => {
    const resposta = await fetch(`${base}/recurso`, { method });
    return {
      status: resposta.status,
      retryAfter: resposta.headers.get("retry-after"),
      body: await resposta.json(),
    };
  };

  beforeEach(() => {
    warnCap = captureWarnings();
    resetShutdown();
  });
  afterEach(() => {
    warnCap.restore();
    server?.close();
    resetShutdown();
    clearQueues();
  });

  test("fora da drenagem, tudo passa", async () => {
    listen();
    expect((await send("POST")).status).toBe(200);
    expect((await send("GET")).status).toBe(200);
  });

  test("em drenagem, POST, PUT, PATCH e DELETE recebem 503 com Retry-After", async () => {
    listen();
    beginDrain();

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(await send(method)).toEqual({
        status: 503,
        retryAfter: "5",
        body: {
          message: "Servidor em atualização. Tente novamente em instantes.",
          code: "SERVER_DRAINING",
        },
      });
    }
  });

  test("em drenagem, GET segue", async () => {
    listen();
    beginDrain();
    expect(await send("GET")).toMatchObject({ status: 200, body: { ok: true } });
  });

  test("aceita outra mensagem e outro Retry-After", async () => {
    listen({ message: "Em manutenção. Tente em um minuto.", retryAfterSeconds: 60 });
    beginDrain();

    expect(await send("POST")).toEqual({
      status: 503,
      retryAfter: "60",
      body: { message: "Em manutenção. Tente em um minuto.", code: "SERVER_DRAINING" },
    });
  });
});

describe("createDrainRouter", () => {
  let warnCap: ReturnType<typeof captureWarnings>;
  let server: Server;
  let base: string;
  let tokenOriginal: string | undefined;
  let nodeEnvOriginal: string | undefined;

  const restoreEnv = (nome: string, valor: string | undefined) => {
    process.env[nome] = valor;
    if (valor === undefined) delete process.env[nome];
  };

  const listen = (options?: Parameters<typeof createDrainRouter>[0]) => {
    const app = express();
    app.use(createDrainRouter(options));
    server = app.listen(0);
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  };

  const call = async (method: string, rota: string, token?: string) => {
    const headers: Record<string, string> = token ? { "x-drain-token": token } : {};
    const resposta = await fetch(`${base}${rota}`, { method, headers });
    return { status: resposta.status, body: await resposta.json() };
  };

  beforeEach(() => {
    warnCap = captureWarnings();
    resetShutdown();
    tokenOriginal = process.env.DRAIN_TOKEN;
    nodeEnvOriginal = process.env.NODE_ENV;
    delete process.env.DRAIN_TOKEN;
    process.env.NODE_ENV = "test";
  });
  afterEach(() => {
    warnCap.restore();
    server?.close();
    resetShutdown();
    clearQueues();
    restoreEnv("DRAIN_TOKEN", tokenOriginal);
    restoreEnv("NODE_ENV", nodeEnvOriginal);
  });

  test("GET /health/lifecycle responde o status", async () => {
    listen({ token: "segredo" });
    expect(await call("GET", "/health/lifecycle")).toEqual({
      status: 200,
      body: { status: "ok", draining: false, activeJobs: 0, ready: false },
    });
  });

  test("POST /internal/drain com o token certo responde 202 e começa a drenagem", async () => {
    listen({ token: "segredo" });

    const resposta = await call("POST", "/internal/drain", "segredo");

    expect(resposta).toEqual({
      status: 202,
      body: { status: "draining", draining: true, activeJobs: 0, ready: true },
    });
    expect(isDraining()).toBe(true);
  });

  test("o status mostra os jobs em voo até o fim", async () => {
    const libera = await holdJob("drain-router");
    listen({ token: "segredo" });

    await call("POST", "/internal/drain", "segredo");
    expect((await call("GET", "/health/lifecycle")).body).toEqual({
      status: "draining",
      draining: true,
      activeJobs: 1,
      ready: false,
    });

    libera();
    while (getInFlightCount() > 0) await delay(2);
    expect((await call("GET", "/health/lifecycle")).body.ready).toBe(true);
  });

  test("POST /internal/drain/cancel responde 200 e retoma", async () => {
    listen({ token: "segredo" });
    await call("POST", "/internal/drain", "segredo");

    const resposta = await call("POST", "/internal/drain/cancel", "segredo");

    expect(resposta).toEqual({
      status: 200,
      body: { status: "ok", draining: false, activeJobs: 0, ready: false },
    });
    expect(isProcessingPaused()).toBe(false);
  });

  test("token errado ou ausente responde 401 e não drena", async () => {
    listen({ token: "segredo" });
    const recusa = {
      status: 401,
      body: { message: "Token de drain inválido.", code: "INVALID_DRAIN_TOKEN" },
    };

    expect(await call("POST", "/internal/drain", "outro")).toEqual(recusa);
    expect(await call("POST", "/internal/drain")).toEqual(recusa);
    expect(isDraining()).toBe(false);

    beginDrain();
    expect(await call("POST", "/internal/drain/cancel", "outro")).toEqual(recusa);
    expect(isDraining()).toBe(true);
  });

  test("sem a opção token, usa o DRAIN_TOKEN do ambiente", async () => {
    process.env.DRAIN_TOKEN = "do-ambiente";
    listen();

    expect((await call("POST", "/internal/drain", "errado")).status).toBe(401);
    expect((await call("POST", "/internal/drain", "do-ambiente")).status).toBe(202);
  });

  test("sem token configurado, as rotas ficam abertas e o logger avisa uma vez", async () => {
    listen();

    expect((await call("POST", "/internal/drain")).status).toBe(202);
    expect((await call("POST", "/internal/drain/cancel")).status).toBe(200);
    const avisos = warnCap.warnings.filter((w) => w.includes("DRAIN_TOKEN"));
    expect(avisos.length).toBe(1);
    expect(avisos[0]).toContain("abertas");
  });

  test("sem token em produção, os POST respondem 401 e o logger avisa uma vez", async () => {
    process.env.NODE_ENV = "production";
    listen();
    const recusa = {
      status: 401,
      body: { message: "Token de drain inválido.", code: "INVALID_DRAIN_TOKEN" },
    };

    expect(await call("POST", "/internal/drain")).toEqual(recusa);
    expect(await call("POST", "/internal/drain", "qualquer")).toEqual(recusa);
    expect(isDraining()).toBe(false);
    beginDrain();
    expect(await call("POST", "/internal/drain/cancel")).toEqual(recusa);
    expect(isDraining()).toBe(true);
    expect((await call("GET", "/health/lifecycle")).status).toBe(200);

    const avisos = warnCap.warnings.filter((w) => w.includes("DRAIN_TOKEN"));
    expect(avisos.length).toBe(1);
    expect(avisos[0]).toContain("recusando");
  });

  test("com token em produção, o token certo passa", async () => {
    process.env.NODE_ENV = "production";
    listen({ token: "segredo" });

    expect((await call("POST", "/internal/drain", "segredo")).status).toBe(202);
    expect(warnCap.warnings.filter((w) => w.includes("DRAIN_TOKEN"))).toEqual([]);
  });

  test("com token, não avisa", () => {
    listen({ token: "segredo" });
    expect(warnCap.warnings.filter((w) => w.includes("DRAIN_TOKEN"))).toEqual([]);
  });

  test("aceita outros caminhos", async () => {
    listen({ token: "segredo", statusPath: "/ciclo", drainPath: "/ops/drenar" });

    expect((await call("GET", "/ciclo")).status).toBe(200);
    expect((await call("POST", "/ops/drenar", "segredo")).status).toBe(202);
    expect((await call("POST", "/ops/drenar/cancel", "segredo")).status).toBe(200);
    expect((await fetch(`${base}/health/lifecycle`)).status).toBe(404);
  });
});
