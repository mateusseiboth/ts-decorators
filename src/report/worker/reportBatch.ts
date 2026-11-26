export interface ReportBatchRange {
  start: number;
  end: number;
  weight: number;
}

export type ReportBatchWeight = (row: any) => number;

function normalizeWeight(value: unknown): number {
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight <= 0) return 1;
  return Math.max(1, Math.ceil(weight));
}

/**
 * Planeja os lotes sem copiar nem reter subarrays dos registros. O limite é por
 * peso de renderização (parcelas/páginas, quando o relatório informa esse peso),
 * e não apenas pela quantidade de linhas consultadas.
 *
 * `mustCutAfter(index)` força a parte a terminar depois da linha `index`, além do
 * corte por peso: é onde um PDF anexado `after-group` entra (ver pdfAttachments.ts).
 */
export function planReportBatches(
  rows: readonly any[],
  maxWeight: number,
  getWeight: ReportBatchWeight = () => 1,
  mustCutAfter: (index: number) => boolean = () => false,
): ReportBatchRange[] {
  const limit = normalizeWeight(maxWeight);
  const ranges: ReportBatchRange[] = [];
  let start = 0;
  let currentWeight = 0;

  for (let index = 0; index < rows.length; index++) {
    const rowWeight = normalizeWeight(getWeight(rows[index]));

    if (index > start && currentWeight + rowWeight > limit) {
      ranges.push({ start, end: index, weight: currentWeight });
      start = index;
      currentWeight = 0;
    }

    currentWeight += rowWeight;

    if (index < rows.length - 1 && mustCutAfter(index)) {
      ranges.push({ start, end: index + 1, weight: currentWeight });
      start = index + 1;
      currentWeight = 0;
    }
  }

  if (start < rows.length) {
    ranges.push({ start, end: rows.length, weight: currentWeight });
  }

  return ranges;
}
