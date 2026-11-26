/**
 * PDFs prontos anexados ao relatório, sem rasterizar: a view diz, por linha, quais PDFs entram e
 * onde (`getPdfAttachments`), e a engine junta as páginas ORIGINAIS no PDF final pelo `pdfunite`.
 *
 * Posições:
 * - `start`: antes da primeira página do relatório;
 * - `after-group`: logo depois do GRUPO da linha. O grupo é a sequência de linhas seguidas com a
 *   mesma `getGroupKey(row)`; sem `getGroupKey`, cada linha é um grupo (ex.: o CRLV depois da
 *   ficha do próprio veículo);
 * - `end`: depois da última página (e das assinaturas).
 *
 * O anexo `after-group` só entra numa fronteira de parte: o planejador corta a parte no fim de todo
 * grupo que tem anexo (`buildAttachmentCuts`), e o anexo vai logo depois da parte onde o grupo
 * termina. As páginas anexadas não recebem "Página X de Y" (são outro documento).
 */
import type { ReportBatchRange } from "./reportBatch";

export type ReportPdfAttachmentPlacement = "start" | "after-group" | "end";

export interface ReportPdfAttachment {
  /** Caminho ABSOLUTO do PDF no disco do processo que gera o relatório. */
  path: string;
  placement: ReportPdfAttachmentPlacement;
  /** Só as primeiras N páginas entram (cópia temporária); sem ele, o PDF inteiro. */
  maxPages?: number;
  /** A engine apaga o arquivo ao terminar o job (sucesso ou falha). */
  temporary?: boolean;
}

export type ReportGetPdfAttachments = (row: any) => readonly ReportPdfAttachment[] | undefined;
export type ReportGetGroupKey = (row: any) => unknown;

/** Onde cada anexo entra: antes de tudo, depois de cada parte (índice da parte) e no fim. */
export interface ReportPdfAttachmentPlan<T = ReportPdfAttachment> {
  start: T[];
  afterPart: T[][];
  end: T[];
}

const PLACEMENTS = new Set<string>(["start", "after-group", "end"]);

const isAttachment = (valor: unknown): valor is ReportPdfAttachment =>
  typeof valor === "object" &&
  valor !== null &&
  typeof (valor as ReportPdfAttachment).path === "string" &&
  PLACEMENTS.has((valor as ReportPdfAttachment).placement);

/** Os anexos válidos da linha; retorno que não é lista não quebra o relatório. */
function readAttachments(row: unknown, getAttachments: ReportGetPdfAttachments) {
  const lista = getAttachments(row);
  return Array.isArray(lista) ? lista.filter(isAttachment) : [];
}

/** O grupo de cada linha: o da view, ou o próprio índice (cada linha é um grupo). */
const buildGroupOf =
  (rows: readonly unknown[], getGroupKey?: ReportGetGroupKey) =>
  (index: number): unknown =>
    getGroupKey ? getGroupKey(rows[index]) : index;

/** A linha `index` é a última do grupo dela? */
const isGroupEnd = (rows: readonly unknown[], groupOf: (i: number) => unknown) => (index: number) =>
  index === rows.length - 1 || !Object.is(groupOf(index), groupOf(index + 1));

/**
 * Os índices depois dos quais a parte TEM de terminar: o fim de cada grupo que tem anexo
 * `after-group`. É o que garante que o anexo cai entre partes, logo depois do grupo.
 */
export function buildAttachmentCuts(
  rows: readonly unknown[],
  getAttachments: ReportGetPdfAttachments,
  getGroupKey?: ReportGetGroupKey,
): Set<number> {
  const groupOf = buildGroupOf(rows, getGroupKey);
  const groupEnds = isGroupEnd(rows, groupOf);
  const cuts = new Set<number>();
  let grupoTemAnexo = false;
  for (let index = 0; index < rows.length; index++) {
    grupoTemAnexo ||= readAttachments(rows[index], getAttachments).some(
      (anexo) => anexo.placement === "after-group",
    );
    if (!groupEnds(index)) continue;
    if (grupoTemAnexo) cuts.add(index);
    grupoTemAnexo = false;
  }
  return cuts;
}

/** A parte que contém a linha `index` (as partes são contíguas e ordenadas). */
function findPartOf(ranges: readonly ReportBatchRange[], index: number): number {
  const parte = ranges.findIndex((range) => index >= range.start && index < range.end);
  return parte === -1 ? ranges.length - 1 : parte;
}

/**
 * Onde cada anexo entra, dadas as partes do plano. O `after-group` de um grupo vai depois da parte
 * em que o grupo TERMINA, na ordem das linhas. Em passada única (uma parte), todos vão depois dela.
 */
export function planPdfAttachments(
  rows: readonly unknown[],
  ranges: readonly ReportBatchRange[],
  getAttachments: ReportGetPdfAttachments,
  getGroupKey?: ReportGetGroupKey,
): ReportPdfAttachmentPlan {
  const plan: ReportPdfAttachmentPlan = {
    start: [],
    afterPart: ranges.map(() => []),
    end: [],
  };
  const groupOf = buildGroupOf(rows, getGroupKey);
  const groupEnds = isGroupEnd(rows, groupOf);
  let pendentes: ReportPdfAttachment[] = [];
  const POSICAO: Record<ReportPdfAttachmentPlacement, (anexo: ReportPdfAttachment) => void> = {
    start: (anexo) => plan.start.push(anexo),
    end: (anexo) => plan.end.push(anexo),
    "after-group": (anexo) => pendentes.push(anexo),
  };
  for (let index = 0; index < rows.length; index++) {
    for (const anexo of readAttachments(rows[index], getAttachments))
      POSICAO[anexo.placement](anexo);
    if (!groupEnds(index) || pendentes.length === 0) continue;
    plan.afterPart[findPartOf(ranges, index)]?.push(...pendentes);
    pendentes = [];
  }
  return plan;
}

/** Há algum anexo a juntar? */
export function hasPdfAttachments(plan: ReportPdfAttachmentPlan<unknown>): boolean {
  return plan.start.length > 0 || plan.end.length > 0 || plan.afterPart.some((l) => l.length > 0);
}

/** A ordem do merge: início, cada parte seguida dos anexos dela, e o fim. */
export function buildMergeOrder(
  partPaths: readonly string[],
  plan: ReportPdfAttachmentPlan<string>,
): string[] {
  return [
    ...plan.start,
    ...partPaths.flatMap((parte, indice) => [parte, ...(plan.afterPart[indice] ?? [])]),
    ...plan.end,
  ];
}
