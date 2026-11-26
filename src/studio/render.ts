/**
 * Compilação do modelo no Studio, com os MESMOS helpers do worker de PDF. Erro de compilação sai
 * com a mensagem do lint (em português e com linha) em vez da do Handlebars.
 */
import Handlebars from "handlebars";

import { registerDefaultReportHelpers } from "../report/templateHelpers";
import { lintTemplate, type TemplateProblem } from "./lint";

/** Marcador do `{{> assinaturas}}` na prévia: o worker preenche com as assinaturas do relatório. */
const ASSINATURAS_DA_PREVIA = `<div style="margin-top: 40px; padding: 18px; border: 1px dashed #9aa0a6;
  border-radius: 6px; color: #5f6368; text-align: center; font: 12px Arial, sans-serif;">
  Assinaturas do relatório
</div>`;

export const STUDIO_PARTIALS: ReadonlySet<string> = new Set(["assinaturas"]);

export class TemplateRenderError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "TemplateRenderError";
  }
}

export interface RenderInput {
  template: string;
  data: unknown;
  partials?: Record<string, string>;
}

function buildEnvironment(partials: Record<string, string>): typeof Handlebars {
  const hbs = Handlebars.create();
  registerDefaultReportHelpers(hbs);
  hbs.registerPartial("assinaturas", ASSINATURAS_DA_PREVIA);
  for (const [name, content] of Object.entries(partials)) {
    hbs.registerPartial(name, String(content ?? ""));
  }
  return hbs;
}

const helperNames = (() => {
  const hbs = Handlebars.create();
  registerDefaultReportHelpers(hbs);
  return new Set(Object.keys(hbs.helpers));
})();

export function lintStudioTemplate(template: string, data: unknown): TemplateProblem[] {
  return lintTemplate(template, { data, helpers: helperNames, partials: STUDIO_PARTIALS });
}

export function renderTemplate({ template, data, partials = {} }: RenderInput): string {
  try {
    return buildEnvironment(partials).compile(template)(data ?? {});
  } catch (error) {
    const problem = lintStudioTemplate(template, undefined).find((p) => p.severity === "error");
    const fallback = error instanceof Error ? error.message : String(error);
    throw new TemplateRenderError(problem?.message ?? fallback, problem?.line);
  }
}
