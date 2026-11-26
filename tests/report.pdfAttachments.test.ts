/**
 * PDFs anexados ao relatório: a view devolve, por linha, PDFs prontos (`getPdfAttachments`) e onde
 * cada um entra: no início, depois do GRUPO da linha (a quebra entre veículos, por exemplo) ou no
 * fim. A engine junta o PDF original, sem rasterizar.
 *
 * O anexo `after-group` só entra numa fronteira de parte: o planejador corta a parte no fim de
 * todo grupo que tem anexo, e o anexo vai logo depois da parte onde o grupo termina.
 */
import { describe, expect, test } from "bun:test";

import {
  buildAttachmentCuts,
  buildMergeOrder,
  hasPdfAttachments,
  planPdfAttachments,
  type ReportPdfAttachment,
} from "../src/report/worker/pdfAttachments";
import { planReportBatches } from "../src/report/worker/reportBatch";

type Linha = { id: string; grupo?: string; anexos?: ReportPdfAttachment[] };

const anexo = (path: string, placement: ReportPdfAttachment["placement"]): ReportPdfAttachment => ({
  path,
  placement,
});
const getAttachments = (row: Linha) => row.anexos;
const getGroupKey = (row: Linha) => row.grupo;

describe("buildAttachmentCuts", () => {
  test("sem getGroupKey, cada linha é um grupo: corta depois de toda linha com anexo after-group", () => {
    const rows: Linha[] = [
      { id: "a", anexos: [anexo("/a.pdf", "after-group")] },
      { id: "b" },
      { id: "c", anexos: [anexo("/c.pdf", "after-group")] },
    ];

    expect([...buildAttachmentCuts(rows, getAttachments)]).toEqual([0, 2]);
  });

  test("com grupo, corta no fim do grupo, mesmo que o anexo venha de uma linha do meio", () => {
    const rows: Linha[] = [
      { id: "1", grupo: "A", anexos: [anexo("/a.pdf", "after-group")] },
      { id: "2", grupo: "A" },
      { id: "3", grupo: "B" },
      { id: "4", grupo: "B" },
    ];

    expect([...buildAttachmentCuts(rows, getAttachments, getGroupKey)]).toEqual([1]);
  });

  test("anexo de início ou de fim não corta parte", () => {
    const rows: Linha[] = [
      { id: "1", anexos: [anexo("/s.pdf", "start"), anexo("/e.pdf", "end")] },
      { id: "2" },
    ];

    expect(buildAttachmentCuts(rows, getAttachments).size).toBe(0);
  });
});

describe("planReportBatches com cortes obrigatórios", () => {
  test("corta pelo peso E depois de cada linha marcada", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ i }));
    const cuts = new Set([1, 4]);

    const ranges = planReportBatches(
      rows,
      3,
      () => 1,
      (index) => cuts.has(index),
    );

    expect(ranges.map(({ start, end }) => [start, end])).toEqual([
      [0, 2],
      [2, 5],
      [5, 6],
    ]);
  });

  test("sem cortes, o plano é o de sempre", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ i }));

    expect(
      planReportBatches(
        rows,
        2,
        () => 1,
        () => false,
      ),
    ).toEqual(planReportBatches(rows, 2));
  });
});

describe("planPdfAttachments", () => {
  test("cada anexo after-group vai depois da parte onde o grupo termina, na ordem das linhas", () => {
    const rows: Linha[] = [
      { id: "1", grupo: "A", anexos: [anexo("/a1.pdf", "after-group")] },
      { id: "2", grupo: "A", anexos: [anexo("/a2.pdf", "after-group")] },
      { id: "3", grupo: "B" },
      { id: "4", grupo: "C", anexos: [anexo("/c.pdf", "after-group")] },
    ];
    const ranges = [
      { start: 0, end: 2, weight: 2 },
      { start: 2, end: 4, weight: 2 },
    ];

    const plano = planPdfAttachments(rows, ranges, getAttachments, getGroupKey);

    expect(plano.afterPart.map((lista) => lista.map((a) => a.path))).toEqual([
      ["/a1.pdf", "/a2.pdf"],
      ["/c.pdf"],
    ]);
    expect(plano.start).toEqual([]);
    expect(plano.end).toEqual([]);
  });

  test("início e fim juntam os de todas as linhas, na ordem das linhas", () => {
    const rows: Linha[] = [
      { id: "1", anexos: [anexo("/s1.pdf", "start"), anexo("/e1.pdf", "end")] },
      { id: "2", anexos: [anexo("/e2.pdf", "end"), anexo("/s2.pdf", "start")] },
    ];

    const plano = planPdfAttachments(rows, [{ start: 0, end: 2, weight: 2 }], getAttachments);

    expect(plano.start.map((a) => a.path)).toEqual(["/s1.pdf", "/s2.pdf"]);
    expect(plano.end.map((a) => a.path)).toEqual(["/e1.pdf", "/e2.pdf"]);
    expect(plano.afterPart).toEqual([[]]);
  });

  test("linha sem anexo, lista vazia e retorno inválido da view não quebram o plano", () => {
    const rows = [{ id: "1" }, { id: "2", anexos: [] }, { id: "3", anexos: "x" }] as Linha[];

    const plano = planPdfAttachments(rows, [{ start: 0, end: 3, weight: 3 }], getAttachments);

    expect(plano).toEqual({ start: [], afterPart: [[]], end: [] });
  });

  test("hasPdfAttachments diz se há o que juntar", () => {
    const vazio = planPdfAttachments(
      [{ id: "1" }],
      [{ start: 0, end: 1, weight: 1 }],
      getAttachments,
    );
    const withAnexo = planPdfAttachments(
      [{ id: "1", anexos: [anexo("/x.pdf", "end")] }],
      [{ start: 0, end: 1, weight: 1 }],
      getAttachments,
    );

    expect(hasPdfAttachments(vazio)).toBe(false);
    expect(hasPdfAttachments(withAnexo)).toBe(true);
  });
});

describe("buildMergeOrder", () => {
  test("início, cada parte seguida dos anexos dela, e o fim", () => {
    expect(
      buildMergeOrder(["/p0.pdf", "/p1.pdf"], {
        start: ["/s.pdf"],
        afterPart: [["/a.pdf", "/b.pdf"], []],
        end: ["/e.pdf"],
      }),
    ).toEqual(["/s.pdf", "/p0.pdf", "/a.pdf", "/b.pdf", "/p1.pdf", "/e.pdf"]);
  });
});
