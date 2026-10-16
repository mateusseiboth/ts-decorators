import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import type { Server } from "http";
import { tmpdir } from "os";
import path from "path";

import express from "express";

import { clearQueues } from "../src/queue/registry";
import { configureReportEngine, resetReportEngine } from "../src/report/config";
import { createReportRouter } from "../src/report/router";
import type { ReportOutputContext, ReportOutputStrategy, ReportResult } from "../src/report/types";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VIEWS_ROOT = path.join(import.meta.dir, "fixtures", "views");

const definitions: Record<string, any> = {
  "rep-1": { id: "rep-1", title: "Demo", tag: "1", model_tag: "26", view_path: "demo" },
};

const fake: ReportOutputStrategy = {
  format: "fake",
  contentType: "text/plain",
  fileExtension: "txt",
  async generate(ctx: ReportOutputContext): Promise<ReportResult> {
    writeFileSync(path.join(ctx.outputDir, `${ctx.job.id}.txt`), "conteudo");
    return {
      file: `${ctx.job.id}.txt`,
      contentType: "text/plain",
      parts: 1,
      bytes: 8,
      durationMs: 1,
    };
  },
};

let server: Server | undefined;

async function startApp(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "bc-router-"));
  configureReportEngine({
    viewsRoot: VIEWS_ROOT,
    outputDir: path.join(dir, "report"),
    queueDbPath: path.join(dir, "queue.db"),
    queueName: "reports-router-test",
    pollMs: 10,
    warmupWorker: false,
    formats: [fake],
    resolveDataSource: () => ({
      report: async () => [{ nome: "A", valor: 1 }],
    }),
  });

  const app = express();
  app.use(express.json());
  app.use(
    "/relatorio/api",
    createReportRouter({
      loadDefinition: async (id) => definitions[id] ?? null,
      buildUser: () => ({ id: "u1", username: "X", entidade: 4 }),
      resolveFormat: () => "fake",
    }),
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server!.address() as { port: number };
  return `http://localhost:${address.port}/relatorio/api`;
}

afterEach(async () => {
  server?.close();
  server = undefined;
  await resetReportEngine();
  clearQueues();
});

describe("createReportRouter", () => {
  test("forge 203 + status + download com Content-Type do formato + delete pós-download", async () => {
    const base = await startApp();

    const forge = await fetch(`${base}/forge/rep-1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ano: 2026 }),
    });
    expect(forge.status).toBe(203);
    const { data } = (await forge.json()) as any;
    expect(data.status).toBe("enqueued");
    expect(data.position).toBe(1);

    await delay(150);

    const status = await fetch(`${base}/queue/status/${data.id}`);
    expect(((await status.json()) as any).data.status).toBe("completed");

    const userJobs = await fetch(`${base}/queue/user`);
    expect(((await userJobs.json()) as any).data.length).toBe(1);

    const download = await fetch(`${base}/download/${data.id}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("text/plain");
    expect(await download.text()).toBe("conteudo");

    await delay(50);
    // Contrato atual: arquivo apagado após o download.
    const again = await fetch(`${base}/download/${data.id}`);
    expect(again.status).toBe(404);
  });

  test("forge de definição inexistente → 404", async () => {
    const base = await startApp();
    const res = await fetch(`${base}/forge/nao-existe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  test("POST /data/:id devolve o viewModel TRATADO (síncrono, sem fila)", async () => {
    const base = await startApp();
    const res = await fetch(`${base}/data/rep-1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.total).toBe(1);
    expect(body.items[0].valorFormatado).toBe("R$ 1.00");
  });

  test("rotas de templates: save → list → setActive → clear", async () => {
    const base = await startApp();

    const created = await fetch(`${base}/templates/rep-1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Do Studio", content: "<i>{{title}}</i>" }),
    });
    expect(created.status).toBe(201);
    const template = ((await created.json()) as any).data;

    const list = await fetch(`${base}/templates/rep-1`);
    expect(((await list.json()) as any).data.length).toBe(1);

    const activate = await fetch(`${base}/templates/rep-1/active/${template.id}`, {
      method: "PUT",
    });
    expect(activate.status).toBe(200);

    const clear = await fetch(`${base}/templates/rep-1/active`, { method: "DELETE" });
    expect(clear.status).toBe(200);
  });
});
