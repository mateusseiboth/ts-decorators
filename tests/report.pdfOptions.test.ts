/**
 * Opções do `page.pdf()` do worker. O tamanho padrão é A4: sem `format`, o Chromium imprimia em
 * Letter, ignorando o `size` do `@page` (a orientação do `@page` ele já respeita). Outro tamanho
 * sai pela opção `pageFormat` da engine; `preferCSSPageSize` faz o `size` do `@page` mandar.
 */
import { describe, expect, test } from "bun:test";

import { buildPdfOptions } from "../src/report/worker/pdfOptions";

const withCabecalho = {
  disableHeaderFooter: false,
  headerHTML: "<b>H</b>",
  footerHTML: "<i>F</i>",
};

describe("buildPdfOptions", () => {
  test("padrão: A4, sem preferCSSPageSize", () => {
    expect(buildPdfOptions(withCabecalho)).toEqual({
      format: "A4",
      displayHeaderFooter: true,
      margin: { top: "130px", bottom: "70px" },
      headerTemplate: `\n    <div style="width:100%; padding:0 20px;">\n      <b>H</b>\n    </div>\n  `,
      footerTemplate: `\n    <div style="width:100%; padding:0 20px; font-size:9px;">\n      <i>F</i>\n    </div>\n  `,
    });
  });

  test("preferCSSPageSize ligado: o tamanho do @page vale, o resto não muda", () => {
    const opcoes = buildPdfOptions({ ...withCabecalho, preferCSSPageSize: true });

    expect(opcoes.preferCSSPageSize).toBe(true);
    expect({ ...opcoes, preferCSSPageSize: undefined }).toEqual({
      ...buildPdfOptions(withCabecalho),
      preferCSSPageSize: undefined,
    });
  });

  test("preferCSSPageSize false é o mesmo que não informar", () => {
    expect(buildPdfOptions({ ...withCabecalho, preferCSSPageSize: false })).toEqual(
      buildPdfOptions(withCabecalho),
    );
  });

  test("outro tamanho pela opção, no lugar do A4", () => {
    expect(buildPdfOptions({ ...withCabecalho, pageFormat: "Letter" }).format).toBe("Letter");
  });

  test("sem cabeçalho e rodapé: margem curta e templates vazios", () => {
    expect(buildPdfOptions({ disableHeaderFooter: true, headerHTML: "", footerHTML: "" })).toEqual({
      format: "A4",
      displayHeaderFooter: false,
      margin: { top: "10px", bottom: "10px", left: "10px", right: "10px" },
      headerTemplate: "",
      footerTemplate: "",
    });
  });
});
