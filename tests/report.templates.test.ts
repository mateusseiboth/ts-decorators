import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { clearQueues } from "../src/queue/registry";
import { configureReportEngine, resetReportEngine } from "../src/report/config";
import { SqliteTemplateStore } from "../src/report/templates/SqliteTemplateStore";
import type { ReportOutputContext, ReportOutputStrategy, ReportResult } from "../src/report/types";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SqliteTemplateStore", () => {
  test("CRUD + template ativo por relatório", () => {
    const store = new SqliteTemplateStore(":memory:");

    const t1 = store.save("rep-1", { name: "Modelo 1", content: "<h1>{{title}}</h1>" });
    const t2 = store.save("rep-1", { name: "Modelo 2", content: "<h2>{{title}}</h2>" });
    store.save("rep-2", { name: "Outro relatório", content: "x" });

    expect(store.list("rep-1").length).toBe(2);
    expect(store.get(t1.id)?.name).toBe("Modelo 1");
    expect(store.getActive("rep-1")).toBeNull();

    store.setActive("rep-1", t2.id);
    expect(store.getActive("rep-1")?.id).toBe(t2.id);

    // Trocar o ativo desativa o anterior; limpar volta ao template do arquivo.
    store.setActive("rep-1", t1.id);
    expect(store.getActive("rep-1")?.id).toBe(t1.id);
    store.setActive("rep-1", null);
    expect(store.getActive("rep-1")).toBeNull();
  });
});

describe("Template ativo na geração", () => {
  afterEach(async () => {
    await resetReportEngine();
    clearQueues();
  });

  test("engine injeta templateSource do template ativo no contexto da strategy", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bc-tpl-"));
    const received: Array<string | undefined> = [];

    const fake: ReportOutputStrategy = {
      format: "fake",
      contentType: "text/plain",
      fileExtension: "txt",
      async generate(ctx: ReportOutputContext): Promise<ReportResult> {
        received.push(ctx.templateSource);
        return {
          file: `${ctx.job.id}.txt`,
          contentType: "text/plain",
          parts: 1,
          bytes: 0,
          durationMs: 0,
        };
      },
    };

    const engine = configureReportEngine({
      viewsRoot: path.join(import.meta.dir, "fixtures", "views"),
      outputDir: path.join(dir, "report"),
      queueDbPath: path.join(dir, "queue.db"),
      queueName: "reports-tpl-test",
      pollMs: 10,
      warmupWorker: false,
      formats: [fake],
      resolveDataSource: () => ({ report: async () => [] }),
    });

    const definition = {
      id: "rep-9",
      title: "Com template",
      tag: "1",
      model_tag: "1",
      view_path: "demo",
    };
    const template = await engine.templateStore.save("rep-9", {
      name: "Custom",
      content: "<b>{{title}}</b>",
    });
    await engine.templateStore.setActive("rep-9", template.id);

    await engine.enqueue({
      definition,
      filters: {},
      exercicio: 2026,
      format: "fake",
      user: { id: "u1", username: "X", entidade: 4 },
    });
    await delay(120);

    expect(received).toEqual(["<b>{{title}}</b>"]);
  });
});
