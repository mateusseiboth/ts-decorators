import { describe, expect, test } from "bun:test";

import { getReportStatusMessage } from "../src/report/notifier";
import type { ReportJobPayload, ReportQueueView } from "../src/report/types";

const job: ReportJobPayload = {
  id: "j1",
  definition: { id: "d1", title: "Depreciação", tag: "18", model_tag: "103", view_path: "x" },
  filters: {},
  exercicio: 2026,
  format: "pdf",
  user: { id: "42", username: "MATEUS#1", entidade: 4 },
};

const view: ReportQueueView = {
  id: "j1",
  title: "Depreciação",
  status: "enqueued",
  format: "pdf",
  user: job.user,
  definition: job.definition,
  filters: {},
  exercicio: 2026,
  createdAt: 1,
  position: 2,
  queueSize: 3,
};

describe("getReportStatusMessage (strategy map)", () => {
  test("mensagens por status", () => {
    expect(getReportStatusMessage(view)).toBe("Relatório na fila. Posição: 2 de 3");
    expect(getReportStatusMessage({ ...view, status: "processing" })).toBe(
      "Processando relatório...",
    );
    expect(getReportStatusMessage({ ...view, status: "completed" })).toBe(
      "Relatório gerado com sucesso.",
    );
    expect(getReportStatusMessage({ ...view, status: "error", error: "boom" })).toBe("boom");
  });
});
