interface DemoRow {
  nome: string;
  valor: number;
}

/** Transformação pura — o MESMO viewModel alimenta template (PDF) e JSON. */
export function buildReportData({ rows, title }: { rows: unknown; title: string }) {
  const items = (Array.isArray(rows) ? rows : []) as DemoRow[];
  const total = items.reduce((acc, item) => acc + Number(item.valor || 0), 0);
  return {
    title,
    items: items.map((item) => ({ ...item, valorFormatado: `R$ ${item.valor.toFixed(2)}` })),
    total,
  };
}
