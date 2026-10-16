import { readFileSync, writeFileSync } from "fs";

/**
 * Numeração CONTÍNUA "Página X de Y" para relatórios gerados em LOTES.
 *
 * Cada parte é um PDF do Chromium INDEPENDENTE, então a numeração nativa do rodapé
 * reinicia por parte ("Página 1 de N" repetido). Aqui, ANTES do merge, reescrevemos a
 * numeração direto em cada parte — que são arquivos PEQUENOS (~poucos MB), então a
 * memória continua limitada (nunca tocamos o PDF final de centenas de MB). Uma faixa
 * branca cobre o número por-parte no canto inferior direito e escrevemos o número
 * CONTÍNUO no lugar.
 *
 * `pdf-lib` é resolvido do app consumidor (mesma estratégia de peer dep do
 * playwright/handlebars) — não adiciona ferramenta de sistema à imagem.
 */
export async function stampContinuousPageNumbers(partPaths: readonly string[]): Promise<void> {
  if (partPaths.length === 0) return;
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");

  // 1) Total de páginas: carrega cada parte só para contar e descarta em seguida.
  const counts: number[] = [];
  let total = 0;
  for (const path of partPaths) {
    const doc = await PDFDocument.load(readFileSync(path), { updateMetadata: false });
    const n = doc.getPageCount();
    counts.push(n);
    total += n;
  }

  // 2) Carimba o número contínuo por página, parte a parte (offset acumulado).
  // Casar com o rodapé (footer.hbs / footer wrapper): `font-size:9px` e `font-family:Arial`.
  // Pontos do PDF ≠ px do CSS: 9px * 72/96 = 6,75pt (antes estava 9pt = 12px → 33% maior, o que
  // deixava o número "de outra fonte"/desalinhado). Helvetica é o equivalente padrão do Arial no
  // pd-lib. `y`/`x` alinham à faixa do rodapé (canto inferior direito) — ajustáveis por env se
  // o render real pedir. Para um match EXATO da fonte dá pra embutir a Arial/Liberation (fontkit).
  const size = Number(process.env.REPORT_PAGE_NUMBER_SIZE) || 6.75;
  const bottom = Number(process.env.REPORT_PAGE_NUMBER_Y) || 22;
  const rightPad = Number(process.env.REPORT_PAGE_NUMBER_RIGHT_PAD) || 20;
  let offset = 0;
  for (let i = 0; i < partPaths.length; i++) {
    const path = partPaths[i]!;
    const doc = await PDFDocument.load(readFileSync(path), { updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.getPages().forEach((page, idx) => {
      const label = `Página ${offset + idx + 1} de ${total}`;
      const { width } = page.getSize();
      const textWidth = font.widthOfTextAtSize(label, size);
      // O número por-parte do Chromium foi SUPRIMIDO no render (footer com {{#unless hidePageNumber}}),
      // então aqui só escrevemos o número CONTÍNUO no canto inferior direito — sem faixa de cobertura
      // e sem texto-fantasma por baixo. Posição alinhada à faixa do rodapé.
      page.drawText(label, {
        x: width - textWidth - rightPad,
        y: bottom,
        size,
        font,
        color: rgb(0, 0, 0),
      });
    });
    writeFileSync(path, await doc.save());
    offset += counts[i]!;
  }
}
