/** View de fixture: uma página por linha e os PDFs anexados que a linha traz. */
export async function buildReportHTML({ rows }: { rows: unknown }) {
  const linhas = (Array.isArray(rows) ? rows : []) as Array<{ id: string }>;
  return { html: linhas.map((linha) => `<p>${linha.id}</p>`).join("") };
}

export const getPdfAttachments = (row: { anexos?: unknown }) => row.anexos as never;
