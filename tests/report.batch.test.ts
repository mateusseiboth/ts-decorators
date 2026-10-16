import { describe, expect, test } from "bun:test";

import { planReportBatches } from "../src/report/worker/reportBatch";

describe("planReportBatches (lotes por peso de renderização)", () => {
  test("sem peso custom: divide por quantidade", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ i }));
    const plan = planReportBatches(rows, 4);
    expect(plan).toEqual([
      { start: 0, end: 4, weight: 4 },
      { start: 4, end: 8, weight: 4 },
      { start: 8, end: 10, weight: 2 },
    ]);
  });

  test("peso por registro (ex.: parcelas do carnê) fecha o lote antes do limite", () => {
    const rows = [{ p: 3 }, { p: 3 }, { p: 3 }, { p: 1 }];
    const plan = planReportBatches(rows, 5, (row: any) => row.p);
    expect(plan).toEqual([
      { start: 0, end: 1, weight: 3 },
      { start: 1, end: 2, weight: 3 },
      { start: 2, end: 4, weight: 4 },
    ]);
  });

  test("registro único acima do limite ainda vira um lote (nunca trava)", () => {
    const plan = planReportBatches([{ p: 99 }], 5, (row: any) => row.p);
    expect(plan).toEqual([{ start: 0, end: 1, weight: 99 }]);
  });

  test("vazio → sem lotes", () => {
    expect(planReportBatches([], 5)).toEqual([]);
  });
});
