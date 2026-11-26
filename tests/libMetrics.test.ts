/**
 * As métricas que o próprio pacote grava, pelo caminho real de cada recurso: trava do banco,
 * idempotência, trava otimista, permissão, auditoria, relatório, drain, saúde, erros e processo.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AdvisoryLockTimeoutError, withAdvisoryLock } from "../src/decorators/advisoryLock";
import { DAOFor, ModelTagged } from "../src/decorators/getModel";
import {
  clearHealthChecks,
  registerHealthCheck,
  runHealthChecks,
} from "../src/decorators/healthCheck";
import { withIdempotency } from "../src/decorators/idempotentMethod";
import { beginDrain, cancelDrain, resetShutdown } from "../src/decorators/shutdown";
import { OptimisticLockError } from "../src/errors/optimisticLock";
import { updateById } from "../src/functions/updateById";
import { idempotencyMiddleware } from "../src/middlwares/idempotent";
import { recordAppError } from "../src/observability/appErrors";
import { registerDefaultMetrics } from "../src/observability/defaultMetrics";
import { authorize, decideRouteAccess } from "../src/permissions/authorize";
import { configurePermissions, resetPermissions } from "../src/permissions/config";
import { PermissionDeniedError } from "../src/permissions/PermissionDeniedError";
import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import { clearQueues } from "../src/queue/registry";
import { configureReportEngine, resetReportEngine } from "../src/report/config";
import type { ReportOutputContext, ReportOutputStrategy, ReportResult } from "../src/report/types";
import { AuditLogger } from "../src/storage/AuditLogger";
import { FakeCollection, fakeCombinators, fakeDb8 } from "../src/testing/prisma8Fakes";
import { mockNext, mockReq, mockRes } from "./_helpers";
import { sortTextos, startColetor, type Coletor } from "./_metricas";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(isPronto: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const limite = Date.now() + timeoutMs;
  while (!(await isPronto())) {
    if (Date.now() > limite) throw new Error("A condição não foi atendida a tempo.");
    await delay(5);
  }
}

const tmp = () => mkdtempSync(path.join("/dev/shm", "bc-metricas-"));

let coletor: Coletor;
beforeEach(() => {
  coletor = startColetor();
});
afterEach(() => coletor.stop());

describe("app.advisory_lock.wait.duration", () => {
  function fakeTx7(falha?: Error, getLock: unknown = 1n) {
    return {
      async $executeRawUnsafe(sql: string) {
        if (falha && sql.startsWith("SELECT pg_advisory_xact_lock")) throw falha;
        return 1;
      },
      async $queryRawUnsafe(sql: string) {
        return sql.includes("GET_LOCK") ? [{ travou: getLock }] : [{ liberou: 1n }];
      },
    };
  }

  test("adquirido e timeout, no Postgres e no MySQL; só a espera, não a função", async () => {
    await withAdvisoryLock(fakeTx7(), "remessa:1", () => delay(30));
    await expect(
      withAdvisoryLock(
        fakeTx7(new Error("canceling statement due to lock timeout")),
        "r:2",
        () => 1,
        {
          waitMs: 10,
        },
      ),
    ).rejects.toBeInstanceOf(AdvisoryLockTimeoutError);
    await expect(
      withAdvisoryLock(fakeTx7(undefined, 0), "r:3", () => 1, { dialect: "mysql", waitMs: 1000 }),
    ).rejects.toBeInstanceOf(AdvisoryLockTimeoutError);

    const pontos = await coletor.histogram("app.advisory_lock.wait.duration");
    expect(pontos.map(({ attributes, count }) => ({ attributes, count }))).toEqual([
      { attributes: { outcome: "adquirido" }, count: 1 },
      { attributes: { outcome: "timeout" }, count: 2 },
    ]);
    expect(pontos[0]?.sum).toBeLessThan(0.025);
  });

  test("erro do banco que não é timeout: outcome erro", async () => {
    await expect(
      withAdvisoryLock(fakeTx7(new Error("conexão caiu")), "r:4", () => 1),
    ).rejects.toThrow("conexão caiu");
    const [ponto] = await coletor.histogram("app.advisory_lock.wait.duration");
    expect(ponto?.attributes).toEqual({ outcome: "erro" });
  });
});

describe("app.idempotency.replay", () => {
  test("withIdempotency: a segunda chamada com a mesma chave é replay", async () => {
    const chave = `baixa:${Math.random()}`;
    await withIdempotency(chave, () => "baixada");
    await withIdempotency(chave, () => "baixada");
    await withIdempotency(`${chave}:outra`, () => "baixada");
    expect(await coletor.points("app.idempotency.replay")).toEqual([{ attributes: {}, value: 1 }]);
  });

  test("middleware HTTP: a resposta reproduzida conta", async () => {
    const mw = idempotencyMiddleware({ identify: () => "dono" });
    const key = `key-${Math.random()}`;
    const req = () => {
      const headers: Record<string, string> = { "idempotency-key": key };
      const r = mockReq({ method: "POST", headers, originalUrl: "/a", url: "/a" });
      r.header = (name: string) => headers[name.toLowerCase()];
      return r;
    };

    const primeira = mockRes();
    await mw(req(), primeira, mockNext());
    primeira.status(201).json({ id: 1 });
    await mw(req(), mockRes(), mockNext());

    expect(await coletor.points("app.idempotency.replay")).toEqual([{ attributes: {}, value: 1 }]);
  });
});

describe("app.optimistic_lock.conflict", () => {
  @ModelTagged
  class ImovelMetricaModel {
    static tag = 9701;
  }

  @DAOFor(ImovelMetricaModel.tag, { optimisticLock: true })
  class ImovelMetricaDAO {}

  beforeEach(() => configurePrisma8({ db: fakeDb8(), ...fakeCombinators }));
  afterEach(() => resetPrisma8());

  test("Prisma 7: o model do DAO; Prisma 8: o model da coleção", async () => {
    const delegate = {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => ({ id: "i1" }),
    };
    const versao = { updated_at: "2026-01-10T14:30:00.123Z" };
    await expect(
      updateById(delegate, "i1", versao, { dao: ImovelMetricaDAO }),
    ).rejects.toBeInstanceOf(OptimisticLockError);

    const colecao = new FakeCollection({ Parcela: { fields: ["id", "updated_at"] } }, "Parcela", {
      // O UPDATE condicional não casa; a releitura pelo id acha o registro.
      rows: (state) => (JSON.stringify(state.where).includes('"gte"') ? [] : [{ id: "p1" }]),
    });
    await expect(
      updateById(colecao, "p1", versao, { dao: ImovelMetricaDAO }),
    ).rejects.toBeInstanceOf(OptimisticLockError);

    expect(await coletor.points("app.optimistic_lock.conflict")).toEqual([
      { attributes: { "db.collection.name": "ImovelMetricaModel" }, value: 1 },
      { attributes: { "db.collection.name": "Parcela" }, value: 1 },
    ]);
  });
});

describe("app.permission.denied", () => {
  const TAG = 9851;

  beforeEach(() =>
    configurePermissions<object>({
      catalog: { [TAG]: { label: "Teste", actions: { edit: { label: "Editar" } } } },
      getContext: () => ({}),
      resolveSubject: () => ({ roles: { [TAG]: { read: true } } }),
    }),
  );
  afterEach(() => resetPermissions());

  test("authorize negado conta com a tag; liberado não conta", async () => {
    await authorize(`${TAG}:read`);
    await expect(authorize(`${TAG}:edit`)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(authorize(`${TAG}:read`, { check: () => false })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );

    expect(await coletor.points("app.permission.denied")).toEqual([
      { attributes: { permissao: String(TAG) }, value: 2 },
    ]);
  });

  test("decideRouteAccess: a recusa conta; tag inválida (erro de configuração) não", async () => {
    expect(decideRouteAccess({ context: {}, tag: TAG, action: "edit" })?.status).toBe(403);
    expect(decideRouteAccess({ context: {}, tag: TAG, action: "read" })).toBeNull();
    expect(decideRouteAccess({ context: {}, tag: 1.5, action: "read" })?.status).toBe(500);

    expect(await coletor.points("app.permission.denied")).toEqual([
      { attributes: { permissao: String(TAG) }, value: 1 },
    ]);
  });
});

describe("app.audit.write_failure", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmp();
    AuditLogger.reset();
    AuditLogger.configure({ path: path.join(dir, "audit.db"), rotate: "none", flushIntervalMs: 5 });
  });
  afterEach(() => {
    AuditLogger.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  test("lote que não grava conta cada entrada perdida", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const audit = AuditLogger.getInstance();
      const banco = new Database(path.join(dir, "audit.db"));
      banco.exec("DROP TABLE audit_logs");
      banco.close();

      audit.log({ method: "POST", url: "/a", statusCode: 201 });
      audit.log({ method: "POST", url: "/b", statusCode: 201 });
      audit.flush();
    } finally {
      errorSpy.mockRestore();
    }
    expect(await coletor.points("app.audit.write_failure")).toEqual([{ attributes: {}, value: 2 }]);
  });
});

describe("app.report.render.duration", () => {
  class FakeStrategy implements ReportOutputStrategy {
    readonly format = "fake";
    readonly contentType = "text/plain";
    readonly fileExtension = "txt";
    async generate(ctx: ReportOutputContext): Promise<ReportResult> {
      writeFileSync(path.join(ctx.outputDir, `${ctx.job.id}.txt`), "ok");
      return {
        file: `${ctx.job.id}.txt`,
        contentType: "text/plain",
        parts: 1,
        bytes: 2,
        durationMs: 1,
      };
    }
  }

  let dir: string;
  afterEach(async () => {
    await resetReportEngine();
    clearQueues();
    rmSync(dir, { recursive: true, force: true });
  });

  test("relatório gerado e relatório que falhou, pelo id da definição", async () => {
    dir = tmp();
    let falhar = false;
    const engine = configureReportEngine({
      viewsRoot: path.join(import.meta.dir, "fixtures", "views"),
      outputDir: path.join(dir, "report"),
      queueDbPath: path.join(dir, "queue.db"),
      queueName: "reports-metricas",
      pollMs: 10,
      warmupWorker: false,
      formats: [new FakeStrategy()],
      resolveDataSource: () => ({
        report: async () => {
          if (falhar) throw new Error("fonte fora");
          return [{ nome: "A" }];
        },
      }),
    });
    const definition = {
      id: "carne-iptu",
      title: "Carnê",
      tag: "1",
      model_tag: "26",
      view_path: "demo",
    };
    const user = { id: "u1", username: "ANA", entidade: 4 };

    const ok = await engine.enqueue({ definition, filters: {}, format: "fake", user });
    await waitUntil(() => engine.getStatus(ok.id)?.status === "completed");
    falhar = true;
    const erro = await engine.enqueue({ definition, filters: {}, format: "fake", user });
    await waitUntil(() => engine.getStatus(erro.id)?.status === "error");

    const pontos = await coletor.histogram("app.report.render.duration");
    expect(pontos.map(({ attributes, count }) => ({ attributes, count }))).toEqual([
      { attributes: { relatorio: "carne-iptu", outcome: "ok" }, count: 1 },
      { attributes: { relatorio: "carne-iptu", outcome: "erro" }, count: 1 },
    ]);
  });
});

describe("app.errors", () => {
  test("a classe do erro e o status da resposta", async () => {
    recordAppError(new OptimisticLockError("i1"));
    recordAppError(new TypeError("x"), { statusCode: 500 });
    recordAppError(new PermissionDeniedError("negado"));
    recordAppError("texto solto");

    const pontos = await coletor.points("app.errors");
    expect(pontos).toEqual([
      {
        attributes: { "error.type": "OptimisticLockError", "http.response.status_code": 409 },
        value: 1,
      },
      { attributes: { "error.type": "TypeError", "http.response.status_code": 500 }, value: 1 },
      {
        attributes: { "error.type": "PermissionDeniedError", "http.response.status_code": 403 },
        value: 1,
      },
      { attributes: { "error.type": "_OTHER", "http.response.status_code": 500 }, value: 1 },
    ]);
  });
});

describe("registerDefaultMetrics", () => {
  afterEach(() => {
    resetShutdown();
    clearHealthChecks();
  });

  test("é idempotente: a segunda chamada devolve o mesmo desligar", () => {
    const dispose = registerDefaultMetrics({ runtime: false });
    try {
      expect(registerDefaultMetrics({ runtime: false })).toBe(dispose);
    } finally {
      dispose();
    }
  });

  test("app.drain.active: 1 drenando, 0 fora", async () => {
    const dispose = registerDefaultMetrics({ runtime: false });
    try {
      expect(await coletor.points("app.drain.active")).toEqual([{ attributes: {}, value: 0 }]);
      beginDrain();
      expect(await coletor.points("app.drain.active")).toEqual([{ attributes: {}, value: 1 }]);
      cancelDrain();
      expect(await coletor.points("app.drain.active")).toEqual([{ attributes: {}, value: 0 }]);
    } finally {
      dispose();
    }
  });

  test("app.health.check: o último resultado de cada sonda", async () => {
    const dispose = registerDefaultMetrics({ runtime: false });
    try {
      registerHealthCheck("banco", () => true);
      registerHealthCheck("sefaz", () => false, { critical: false });
      expect(await coletor.points("app.health.check")).toEqual([]);

      await runHealthChecks();
      expect(await coletor.points("app.health.check")).toEqual([
        { attributes: { check: "banco" }, value: 1 },
        { attributes: { check: "sefaz" }, value: 0 },
      ]);
    } finally {
      dispose();
    }
  });

  test("processo: memória, CPU, uptime e atraso do event loop", async () => {
    const dispose = registerDefaultMetrics({ eventLoopSampleMs: 20 });
    try {
      // O monitor do Bun só enxerga o bloqueio depois do primeiro tique dele.
      await delay(30);
      const inicio = Date.now();
      while (Date.now() - inicio < 40) {
        // Segura o event loop para a amostra ter atraso.
      }
      await delay(60);

      const memoria = await coletor.points("process.memory.usage");
      expect(sortTextos(memoria.map((ponto) => ponto.attributes.type))).toEqual([
        "external",
        "heap_total",
        "heap_used",
        "rss",
      ]);
      expect(memoria.every((ponto) => ponto.value >= 0)).toBe(true);
      expect((await coletor.find("process.memory.usage"))?.descriptor.unit).toBe("By");

      const cpu = await coletor.points("process.cpu.time");
      expect(sortTextos(cpu.map((ponto) => ponto.attributes["cpu.mode"]))).toEqual([
        "system",
        "user",
      ]);
      expect(cpu.find((ponto) => ponto.attributes["cpu.mode"] === "user")?.value).toBeGreaterThan(
        0,
      );

      const [uptime] = await coletor.points("process.uptime");
      expect(uptime?.value).toBeGreaterThan(0);

      const [atraso] = await coletor.histogram("process.event_loop.delay");
      expect(atraso?.count).toBeGreaterThan(0);
      expect(atraso?.sum).toBeGreaterThan(0.01);
    } finally {
      dispose();
    }
  });
});
