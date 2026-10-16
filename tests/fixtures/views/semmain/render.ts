/** View SEM main.ts — usada para provar que JSON falha sem fallback. */
export async function buildReportHTML(): Promise<{ html: string }> {
  return { html: "<html></html>" };
}
