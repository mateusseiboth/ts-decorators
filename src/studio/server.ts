import { REPORT_HELPER_DOCS } from "../report/templateHelpers";
import { runAppAction } from "./appProxy";
/**
 * Servidor local do Studio, em `Bun.serve`. A página é um cliente TypeScript de verdade
 * (`client/index.html`), empacotado pelo próprio Bun na primeira requisição.
 *
 *  - GET  /api/helpers        catálogo de funções (mesma fonte do worker de PDF).
 *  - GET  /api/starters       modelos prontos da galeria "Novo".
 *  - POST /api/render         compila o modelo e devolve o HTML da prévia.
 *  - POST /api/lint           problemas do modelo (sintaxe, função e campo inexistentes).
 *  - POST /api/pdf            PDF real, pelo Chromium do playwright.
 *  - POST /api/app/:action    conversa com o `createReportRouter` do app (ver appProxy).
 */
import page from "./client/index.html";
import {
  createChromiumPdfRenderer,
  parsePdfOptions,
  StudioPdfUnavailableError,
  type StudioPdfRenderer,
} from "./pdf";
import { lintStudioTemplate, renderTemplate, TemplateRenderError } from "./render";
import { STUDIO_STARTERS } from "./starters";

export { StudioPdfUnavailableError, type StudioPdfOptions, type StudioPdfRenderer } from "./pdf";

export interface StudioServerOptions {
  /** 0 escolhe uma porta livre. */
  port: number;
  /** Gera o PDF da prévia. Default: Chromium do playwright, aberto sob demanda. */
  renderPdf?: StudioPdfRenderer;
  /**
   * Endereços dos sistemas com que o Studio pode conversar (ex.: "http://app:3000"). Vazio aceita
   * qualquer um: é o uso local. No Studio hospedado, defina para ele não virar proxy aberto.
   */
  allowedOrigins?: readonly string[];
}

export interface StudioServer {
  url: string;
  stop(): Promise<void>;
}

type Body = Record<string, unknown>;

const json = (status: number, body: unknown) => Response.json(body, { status });

const textOf = (value: unknown) => (typeof value === "string" ? value : "");

async function readBody(request: Request): Promise<Body> {
  const body: unknown = await request.json().catch(() => ({}));
  return body && typeof body === "object" ? (body as Body) : {};
}

function renderFromBody(body: Body): string {
  return renderTemplate({
    template: textOf(body.template),
    data: body.data,
    partials: (body.partials as Record<string, string> | undefined) ?? {},
  });
}

function onRenderError(error: unknown): Response {
  if (error instanceof TemplateRenderError) {
    return json(422, { message: error.message, line: error.line });
  }
  throw error;
}

function render(body: Body): Response {
  const started = performance.now();
  try {
    const html = renderFromBody(body);
    return json(200, { html, ms: Math.round(performance.now() - started) });
  } catch (error) {
    return onRenderError(error);
  }
}

async function pdf(body: Body, renderPdf: StudioPdfRenderer): Promise<Response> {
  let html: string;
  try {
    html = renderFromBody(body);
  } catch (error) {
    return onRenderError(error);
  }
  try {
    const bytes = await renderPdf(html, parsePdfOptions(body));
    return new Response(bytes, { headers: { "content-type": "application/pdf" } });
  } catch (error) {
    if (error instanceof StudioPdfUnavailableError) return json(501, { message: error.message });
    const detalhe = error instanceof Error ? error.message : String(error);
    return json(500, { message: `Não foi possível gerar o PDF. ${detalhe}` });
  }
}

export async function startStudioServer(options: StudioServerOptions): Promise<StudioServer> {
  const chromium = options.renderPdf ? null : createChromiumPdfRenderer();
  const renderPdf = options.renderPdf ?? chromium!.render;

  const server = Bun.serve({
    port: options.port,
    // Explícito: com a porta compartilhada, um Studio esquecido aberto responderia metade das
    // requisições com a versão antiga.
    reusePort: false,
    development: false,
    routes: {
      "/": page,
      "/api/helpers": { GET: () => Response.json(REPORT_HELPER_DOCS) },
      "/api/starters": { GET: () => Response.json(STUDIO_STARTERS) },
      "/api/render": { POST: async (request) => render(await readBody(request)) },
      "/api/lint": {
        POST: async (request) => {
          const body = await readBody(request);
          const problems = lintStudioTemplate(textOf(body.template), body.data);
          return Response.json({ problems });
        },
      },
      "/api/pdf": { POST: async (request) => pdf(await readBody(request), renderPdf) },
      "/api/app/:action": {
        POST: async (request) =>
          runAppAction(request.params.action, await readBody(request), options.allowedOrigins),
      },
    },
    fetch: () => json(404, { message: "Rota não encontrada." }),
  });

  return {
    url: server.url.href,
    async stop() {
      await chromium?.close();
      await server.stop(true);
    },
  };
}
