/**
 * Opções do `page.pdf()` do worker, separadas para serem testáveis sem Chromium.
 *
 * O tamanho é A4 por padrão. Sem `format`, o Chromium imprime em Letter e ignora o `size` do
 * `@page` (a orientação do `@page` ele respeita): um template A4 paisagem saía em Letter paisagem.
 * `pageFormat` troca o tamanho padrão; `preferCSSPageSize` faz o `size` do `@page` mandar, para o
 * template que declara um tamanho próprio.
 */
import type { ReportPageFormat } from "../types";

export const DEFAULT_PAGE_FORMAT: ReportPageFormat = "A4";

export interface PdfOptionsInput {
  disableHeaderFooter: boolean;
  headerHTML: string;
  footerHTML: string;
  pageFormat?: ReportPageFormat;
  preferCSSPageSize?: boolean;
}

const MARGEM_SEM_CABECALHO = { top: "10px", bottom: "10px", left: "10px", right: "10px" };
const MARGEM_COM_CABECALHO = { top: "130px", bottom: "70px" };

const wrapHeader = (html: string) =>
  `\n    <div style="width:100%; padding:0 20px;">\n      ${html}\n    </div>\n  `;
const wrapFooter = (html: string) =>
  `\n    <div style="width:100%; padding:0 20px; font-size:9px;">\n      ${html}\n    </div>\n  `;

export function buildPdfOptions({
  disableHeaderFooter,
  headerHTML,
  footerHTML,
  pageFormat = DEFAULT_PAGE_FORMAT,
  preferCSSPageSize = false,
}: PdfOptionsInput) {
  return {
    format: pageFormat,
    ...(preferCSSPageSize && { preferCSSPageSize: true }),
    displayHeaderFooter: !disableHeaderFooter,
    margin: disableHeaderFooter ? MARGEM_SEM_CABECALHO : MARGEM_COM_CABECALHO,
    headerTemplate: disableHeaderFooter ? "" : wrapHeader(headerHTML),
    footerTemplate: disableHeaderFooter ? "" : wrapFooter(footerHTML),
  };
}
