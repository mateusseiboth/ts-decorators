import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "fs";
import { createServer } from "node:http";
import { tmpdir } from "os";
import path from "path";

import "reflect-metadata";

import { container } from "../src/decorators/container";
import { Cron, startCronJobs, stopAllCronJobs } from "../src/decorators/cron";
import {
  beginDrain,
  disposeShutdownHooks,
  enableGracefulShutdown,
  getDrainStatus,
  initShutdownHooks,
  isDraining,
  isShuttingDown,
  OnShutdown,
  onShutdown,
  resetShutdown,
  runShutdown,
} from "../src/decorators/shutdown";
import { InMemoryQueueAdapter } from "../src/queue/InMemoryQueueAdapter";
import {
  clearQueues,
  enqueue,
  getInFlightCount,
  getQueueAdapter,
  isProcessingPaused,
  registerProcessor,
  registerQueue,
  startProcessors,
} from "../src/queue/registry";
import { configureReportEngine, resetReportEngine } from "../src/report/config";
import { captureWarnings } from "./_helpers";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nunca = () => new Promise<never>(() => undefined);

const namesOf = (results: { name: string }[]) => results.map((r) => r.name);
const findStep = (results: { name: string }[], name: string) =>
  results.find((r) => r.name === name) as any;

describe("runShutdown", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    warnCap = captureWarnings();
    resetShutdown();
  });
  afterEach(async () => {
    warnCap.restore();
    resetShutdown();
    clearQueues();
    stopAllCronJobs();
    container.clear();
    await resetReportEngine();
  });

  test("roda os ganchos do menor order para o maior, estável no empate", async () => {
    const ordem: string[] = [];
    onShutdown("fecha-banco", () => void ordem.push("fecha-banco"), { order: 200 });
    onShutdown("a", () => void ordem.push("a"));
    onShutdown("primeiro", () => void ordem.push("primeiro"), { order: 1 });
    onShutdown("b", () => void ordem.push("b"));

    const results = await runShutdown();

    expect(ordem).toEqual(["primeiro", "a", "b", "fecha-banco"]);
    expect(namesOf(results).slice(-4)).toEqual(["primeiro", "a", "b", "fecha-banco"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("os passos internos vêm antes dos ganchos, na ordem", async () => {
    onShutdown("gancho", () => undefined);
    const results = await runShutdown();
    expect(namesOf(results)).toEqual(["drenagem das filas", "cron e processadores", "gancho"]);
  });

  test("erro num gancho é registrado e a sequência segue", async () => {
    const ordem: string[] = [];
    onShutdown(
      "quebra",
      () => {
        throw new Error("falhou ao fechar");
      },
      { order: 1 },
    );
    onShutdown("rejeita", () => Promise.reject(new Error("rejeitou")), { order: 2 });
    onShutdown("depois", () => void ordem.push("depois"), { order: 3 });

    const results = await runShutdown();

    expect(findStep(results, "quebra")).toMatchObject({ ok: false, error: "falhou ao fechar" });
    expect(findStep(results, "rejeita")).toMatchObject({ ok: false, error: "rejeitou" });
    expect(ordem).toEqual(["depois"]);
    expect(findStep(results, "depois").ok).toBe(true);
  });

  test("gancho que estoura o próprio timeoutMs é registrado e a sequência segue", async () => {
    const ordem: string[] = [];
    onShutdown("lento", nunca, { order: 1, timeoutMs: 20 });
    onShutdown("depois", () => void ordem.push("depois"), { order: 2 });

    const results = await runShutdown();

    const lento = findStep(results, "lento");
    expect(lento.ok).toBe(false);
    expect(lento.error).toContain("20");
    expect(lento.durationMs).toBeGreaterThanOrEqual(15);
    expect(ordem).toEqual(["depois"]);
  });

  test("é idempotente: devolve a mesma promise e roda os ganchos uma vez", async () => {
    let chamadas = 0;
    onShutdown("conta", () => void chamadas++);

    expect(isShuttingDown()).toBe(false);
    const primeira = runShutdown();
    expect(isShuttingDown()).toBe(true);
    const segunda = runShutdown();

    expect(segunda).toBe(primeira);
    await primeira;
    expect(chamadas).toBe(1);
  });

  test("a função devolvida por onShutdown remove o gancho", async () => {
    let chamadas = 0;
    const remove = onShutdown("removido", () => void chamadas++);
    remove();

    const results = await runShutdown();

    expect(chamadas).toBe(0);
    expect(namesOf(results)).not.toContain("removido");
  });

  test("resetShutdown esquece ganchos e estado", async () => {
    let chamadas = 0;
    onShutdown("antigo", () => void chamadas++);
    await runShutdown();
    resetShutdown();

    expect(isShuttingDown()).toBe(false);
    const results = await runShutdown();
    expect(chamadas).toBe(1);
    expect(namesOf(results)).not.toContain("antigo");
  });
});

describe("runShutdown: servidor, filas, cron e relatórios", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    warnCap = captureWarnings();
    resetShutdown();
  });
  afterEach(async () => {
    warnCap.restore();
    resetShutdown();
    clearQueues();
    stopAllCronJobs();
    await resetReportEngine();
  });

  test("fecha o servidor do node:http no primeiro passo", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const results = await runShutdown({ server });

    expect(results[0]).toMatchObject({ name: "servidor", ok: true });
    expect(server.listening).toBe(false);
  });

  test("para o servidor do Bun pelo stop()", async () => {
    let parou = false;
    const server = { stop: () => void (parou = true) };

    const results = await runShutdown({ server });

    expect(parou).toBe(true);
    expect(results[0]).toMatchObject({ name: "servidor", ok: true });
  });

  test("erro ao fechar o servidor é registrado e a sequência segue", async () => {
    const server = createServer();
    // Nunca escutou: o close devolve ERR_SERVER_NOT_RUNNING.
    let rodou = false;
    onShutdown("depois", () => void (rodou = true));

    const results = await runShutdown({ server });

    expect(results[0]).toMatchObject({ name: "servidor", ok: false });
    expect(rodou).toBe(true);
  });

  test("pausa as filas e espera os jobs em voo terminarem", async () => {
    let terminou = false;
    registerQueue("drain-ok", new InMemoryQueueAdapter());
    registerProcessor("drain-ok", {
      handler: async () => {
        await delay(60);
        terminou = true;
      },
      concurrency: 1,
      pollMs: 5,
    });
    startProcessors();
    await enqueue("drain-ok", { id: 1 });
    while (getInFlightCount() === 0) await delay(2);

    const results = await runShutdown({ drainTimeoutMs: 2_000 });

    expect(isProcessingPaused()).toBe(true);
    expect(terminou).toBe(true);
    expect(getInFlightCount()).toBe(0);
    expect(findStep(results, "drenagem das filas").ok).toBe(true);
    const concluidos = await getQueueAdapter("drain-ok")!.findMany({ status: "completed" });
    expect(concluidos.length).toBe(1);
  });

  test("job que passa do drainTimeoutMs é registrado e a sequência segue", async () => {
    registerQueue("drain-lento", new InMemoryQueueAdapter());
    registerProcessor("drain-lento", { handler: () => delay(300), concurrency: 1, pollMs: 5 });
    startProcessors();
    await enqueue("drain-lento", { id: 1 });
    while (getInFlightCount() === 0) await delay(2);
    let rodou = false;
    onShutdown("depois", () => void (rodou = true));

    const results = await runShutdown({ drainTimeoutMs: 30 });

    const drenagem = findStep(results, "drenagem das filas");
    expect(drenagem.ok).toBe(false);
    expect(drenagem.error).toContain("1");
    expect(rodou).toBe(true);
    while (getInFlightCount() > 0) await delay(5);
  });

  test("para o cron", async () => {
    let execucoes = 0;
    class Jobs {
      @Cron(10)
      tick() {
        execucoes++;
      }
    }
    startCronJobs(new Jobs());
    await delay(35);

    await runShutdown();
    const depoisDoShutdown = execucoes;
    await delay(40);

    expect(depoisDoShutdown).toBeGreaterThan(0);
    expect(execucoes).toBe(depoisDoShutdown);
  });

  test("encerra a engine de relatórios configurada", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bc-shutdown-"));
    const engine = configureReportEngine({
      viewsRoot: dir,
      outputDir: path.join(dir, "report"),
      queueDbPath: path.join(dir, "queue.db"),
      queueName: "reports-shutdown-test",
      warmupWorker: false,
      resolveDataSource: () => ({}),
    } as any);
    let encerrou = false;
    const original = engine.shutdown.bind(engine);
    engine.shutdown = async () => {
      encerrou = true;
      await original();
    };

    const results = await runShutdown();

    expect(encerrou).toBe(true);
    expect(namesOf(results)).toContain("relatórios");
    expect(findStep(results, "relatórios").ok).toBe(true);
  });

  test("sem engine de relatórios, o passo não aparece", async () => {
    const results = await runShutdown();
    expect(namesOf(results)).not.toContain("relatórios");
  });
});

describe("runShutdown: drainBeforeClose", () => {
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

  /** Um job em voo que só termina quando `libera()` é chamado. */
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

  const listen = () => {
    const server = createServer((_req, res) => res.end("ok"));
    return new Promise<typeof server>((resolve) => server.listen(0, () => resolve(server)));
  };

  test("drena com o servidor no ar e só depois fecha", async () => {
    const libera = await holdJob("antes-de-fechar");
    const server = await listen();
    const { port } = server.address() as { port: number };

    const desligamento = runShutdown({ server, drainBeforeClose: true, drainTimeoutMs: 2_000 });
    await delay(20);

    expect(isDraining()).toBe(true);
    expect(server.listening).toBe(true);
    const resposta = await fetch(`http://localhost:${port}/`, {
      headers: { connection: "close" },
    });
    expect(await resposta.text()).toBe("ok");

    libera();
    const results = await desligamento;

    expect(server.listening).toBe(false);
    expect(namesOf(results)).toEqual(["drenagem das filas", "servidor", "cron e processadores"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("sem a opção, o servidor fecha antes da drenagem", async () => {
    const libera = await holdJob("fecha-antes");
    const server = await listen();

    const desligamento = runShutdown({ server, drainTimeoutMs: 2_000 });
    await delay(20);

    expect(isDraining()).toBe(true);
    expect(server.listening).toBe(false);

    libera();
    const results = await desligamento;
    expect(namesOf(results)).toEqual(["servidor", "drenagem das filas", "cron e processadores"]);
  });

  test("drenagem já começada por fora: o desligamento só continua esperando", async () => {
    const libera = await holdJob("ja-drenando");
    beginDrain();
    expect(isProcessingPaused()).toBe(true);

    const desligamento = runShutdown({ drainBeforeClose: true, drainTimeoutMs: 2_000 });
    await delay(20);
    expect(getDrainStatus()).toMatchObject({ draining: true, activeJobs: 1, ready: false });

    libera();
    const results = await desligamento;
    expect(findStep(results, "drenagem das filas").ok).toBe(true);
    expect(isDraining()).toBe(true);
  });
});

describe("@OnShutdown", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    warnCap = captureWarnings();
    resetShutdown();
    container.clear();
  });
  afterEach(() => {
    warnCap.restore();
    resetShutdown();
    clearQueues();
    container.clear();
  });

  test("legacy: initShutdownHooks registra com o nome Classe.metodo e o this da instância", async () => {
    class PrismaService {
      fechado = false;

      @OnShutdown({ order: 10 })
      async disconnect() {
        this.fechado = true;
      }
    }

    const service = new PrismaService();
    initShutdownHooks(service);
    const results = await runShutdown();

    expect(service.fechado).toBe(true);
    expect(findStep(results, "PrismaService.disconnect").ok).toBe(true);
  });

  test("respeita order e timeoutMs do decorator", async () => {
    const ordem: string[] = [];
    class Recursos {
      @OnShutdown({ order: 50 })
      fecharFila() {
        ordem.push("fila");
      }

      @OnShutdown({ order: 5, timeoutMs: 20 })
      travado() {
        ordem.push("travado");
        return nunca();
      }
    }

    initShutdownHooks(new Recursos());
    const results = await runShutdown();

    expect(ordem).toEqual(["travado", "fila"]);
    expect(findStep(results, "Recursos.travado").ok).toBe(false);
  });

  test("initShutdownHooks é idempotente por instância", async () => {
    let chamadas = 0;
    class Servico {
      @OnShutdown()
      encerrar() {
        chamadas++;
      }
    }

    const servico = new Servico();
    initShutdownHooks(servico);
    initShutdownHooks(servico);
    await runShutdown();

    expect(chamadas).toBe(1);
  });

  test("duas instâncias registram dois ganchos", async () => {
    let chamadas = 0;
    class Servico {
      @OnShutdown()
      encerrar() {
        chamadas++;
      }
    }

    initShutdownHooks(new Servico());
    initShutdownHooks(new Servico());
    await runShutdown();

    expect(chamadas).toBe(2);
  });

  test("disposeShutdownHooks remove os ganchos da instância", async () => {
    let chamadas = 0;
    class Servico {
      @OnShutdown()
      encerrar() {
        chamadas++;
      }
    }

    const servico = new Servico();
    initShutdownHooks(servico);
    disposeShutdownHooks(servico);
    await runShutdown();

    expect(chamadas).toBe(0);
  });

  test("container.get registra e container.clear remove", async () => {
    let chamadas = 0;
    class ConexaoService {
      @OnShutdown()
      fechar() {
        chamadas++;
      }
    }

    container.get(ConexaoService);
    expect(namesOf(await runShutdown())).toContain("ConexaoService.fechar");
    expect(chamadas).toBe(1);

    resetShutdown();
    container.clear();
    container.get(ConexaoService);
    container.clear();
    await runShutdown();
    expect(chamadas).toBe(1);
  });

  test("TC39: o addInitializer registra o gancho quando a instância nasce", async () => {
    const inicializadores: ((this: unknown) => void)[] = [];
    const contexto = {
      kind: "method",
      name: "fechar",
      addInitializer: (fn: (this: unknown) => void) => void inicializadores.push(fn),
    };
    class Conexao {
      fechada = false;
      fechar() {
        this.fechada = true;
      }
    }
    const original: unknown = Reflect.get(Conexao.prototype, "fechar");
    expect(OnShutdown({ order: 1 })(original, contexto)).toBe(original);

    const conexao = new Conexao();
    for (const init of inicializadores) init.call(conexao);
    const results = await runShutdown();

    expect(conexao.fechada).toBe(true);
    expect(findStep(results, "Conexao.fechar").ok).toBe(true);
  });

  test("subclasse herda o gancho sem mudar a classe base", async () => {
    const ordem: string[] = [];
    class Base {
      @OnShutdown({ order: 1 })
      fecharBase() {
        ordem.push("base");
      }
    }
    class Filha extends Base {
      @OnShutdown({ order: 2 })
      fecharFilha() {
        ordem.push("filha");
      }
    }

    initShutdownHooks(new Base());
    await runShutdown();
    expect(ordem).toEqual(["base"]);

    resetShutdown();
    ordem.length = 0;
    initShutdownHooks(new Filha());
    await runShutdown();
    expect(ordem).toEqual(["base", "filha"]);
  });
});

describe("enableGracefulShutdown", () => {
  let warnCap: ReturnType<typeof captureWarnings>;
  let exitSpy: ReturnType<typeof spyOn>;
  let codigos: (number | string | null | undefined)[] = [];

  beforeEach(() => {
    warnCap = captureWarnings();
    resetShutdown();
    codigos = [];
    exitSpy = spyOn(process, "exit").mockImplementation((code) => {
      codigos.push(code);
      return undefined as never;
    });
  });
  afterEach(() => {
    exitSpy.mockRestore();
    warnCap.restore();
    resetShutdown();
    clearQueues();
  });

  const waitShutdown = async () => {
    while (!isShuttingDown()) await delay(1);
    await runShutdown();
    await delay(5);
  };

  test("o sinal roda o desligamento; exit: false não encerra o processo", async () => {
    let rodou = false;
    onShutdown("gancho", () => void (rodou = true));
    enableGracefulShutdown({ exit: false, signals: ["SIGTERM"] });

    process.emit("SIGTERM");
    await waitShutdown();

    expect(rodou).toBe(true);
    expect(codigos).toEqual([]);
  });

  test("encerra com 0 quando tudo deu certo", async () => {
    enableGracefulShutdown({ signals: ["SIGTERM"] });

    process.emit("SIGTERM");
    await waitShutdown();

    expect(codigos).toEqual([0]);
  });

  test("encerra com 1 quando algum passo falhou", async () => {
    onShutdown("quebra", () => {
      throw new Error("x");
    });
    enableGracefulShutdown({ signals: ["SIGINT"] });

    process.emit("SIGINT");
    await waitShutdown();

    expect(codigos).toEqual([1]);
  });

  test("segundo sinal durante o desligamento força a saída com 1", async () => {
    onShutdown("lento", () => delay(60));
    enableGracefulShutdown({ signals: ["SIGTERM", "SIGINT"] });

    process.emit("SIGTERM");
    await delay(5);
    process.emit("SIGINT");

    expect(codigos).toEqual([1]);
    await runShutdown();
    await delay(5);
  });

  test("ligar duas vezes não duplica a escuta", () => {
    const antes = process.listenerCount("SIGTERM");
    enableGracefulShutdown({ exit: false });
    enableGracefulShutdown({ exit: false });
    expect(process.listenerCount("SIGTERM")).toBe(antes + 1);
    expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(1);
  });

  test("a função devolvida desliga a escuta", () => {
    const antes = process.listenerCount("SIGTERM");
    const disable = enableGracefulShutdown({ exit: false });
    disable();
    expect(process.listenerCount("SIGTERM")).toBe(antes);
  });

  test("resetShutdown desliga a escuta", () => {
    const antes = process.listenerCount("SIGTERM");
    enableGracefulShutdown({ exit: false });
    resetShutdown();
    expect(process.listenerCount("SIGTERM")).toBe(antes);
  });
});

describe("o desligamento segura o processo até terminar", () => {
  test("gancho que nunca termina estoura o prazo e os seguintes ainda rodam", async () => {
    const script = `
      import { onShutdown, runShutdown } from "${import.meta.dir}/../src/decorators/shutdown";
      onShutdown("preso", () => new Promise(() => {}), { order: 1, timeoutMs: 50 });
      onShutdown("segundo", () => console.log("segundo rodou"), { order: 2 });
      void runShutdown().then((passos) => console.log(passos.filter((p) => !p.ok).map((p) => p.name).join(",")));
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LOG_LEVEL: "error" },
    });
    const saida = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(saida).toContain("segundo rodou");
    expect(saida).toContain("preso");
  });

  test("SIGTERM com drainBeforeClose: recusa escrita, responde leitura e sai depois do job", async () => {
    const src = `${import.meta.dir}/../src`;
    const script = `
      import express from "express";
      import { createDrainRouter, rejectWritesWhenDraining } from "${src}/decorators/drain";
      import { enableGracefulShutdown } from "${src}/decorators/shutdown";
      import { InMemoryQueueAdapter } from "${src}/queue/InMemoryQueueAdapter";
      import { enqueue, getInFlightCount, registerProcessor, registerQueue, startProcessors } from "${src}/queue/registry";

      registerQueue("lenta", new InMemoryQueueAdapter());
      registerProcessor("lenta", {
        handler: async () => { await Bun.sleep(300); console.log("job terminou"); },
        concurrency: 1,
        pollMs: 5,
      });
      startProcessors();
      await enqueue("lenta", { id: 1 });
      while (getInFlightCount() === 0) await Bun.sleep(2);

      const app = express();
      app.use(createDrainRouter({ token: "t" }));
      app.use(rejectWritesWhenDraining());
      app.all("/recurso", (_req, res) => { res.json({ ok: true }); });
      const server = app.listen(0, () => console.log("porta " + server.address().port));
      enableGracefulShutdown({ server, drainBeforeClose: true, drainTimeoutMs: 5_000 });
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LOG_LEVEL: "error" },
    });
    const leitor = proc.stdout.getReader();
    let saida = "";
    while (!/porta (\d+)/.test(saida)) {
      const { value, done } = await leitor.read();
      if (done) break;
      saida += new TextDecoder().decode(value);
    }
    const porta = /porta (\d+)/.exec(saida)?.[1];
    const base = `http://localhost:${porta}`;
    const withoutKeepAlive = { headers: { connection: "close" } };

    proc.kill("SIGTERM");
    await delay(50);
    const leitura = await fetch(`${base}/recurso`, withoutKeepAlive);
    const escrita = await fetch(`${base}/recurso`, { ...withoutKeepAlive, method: "POST" });
    const ciclo = await (await fetch(`${base}/health/lifecycle`, withoutKeepAlive)).json();

    expect(leitura.status).toBe(200);
    expect(escrita.status).toBe(503);
    expect(ciclo).toMatchObject({
      status: "draining",
      draining: true,
      activeJobs: 1,
      ready: false,
    });

    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      saida += new TextDecoder().decode(value);
    }
    expect(await proc.exited).toBe(0);
    expect(saida).toContain("job terminou");
  });
});
