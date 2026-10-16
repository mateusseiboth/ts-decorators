/**
 * Servidor local do Studio — serve a página do editor e faz o meio-campo com o
 * app alvo (evita CORS no navegador e reusa o Handlebars do servidor):
 *
 *  - POST /api/fetch-data  → proxy para a rota síncrona de dados do app
 *                            (POST .../data/:reportId, com os headers do usuário).
 *  - POST /api/render      → compila o HBS com os MESMOS helpers default do
 *                            worker (src/report/templateHelpers) e devolve o HTML.
 *  - GET  /api/helpers     → catálogo de helpers para o menu "Inserir função".
 *  - POST /api/export      → proxy para POST .../templates/:reportId do app.
 *
 * express e handlebars são peer deps já presentes nos apps consumidores.
 */
import express, { type Request, type Response } from "express";
import Handlebars from "handlebars";

import { REPORT_HELPER_DOCS, registerDefaultReportHelpers } from "../report/templateHelpers";
import { studioPage } from "./page";

function parseHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length) headers[key] = value;
  }
  return headers;
}

export async function startStudioServer(port: number): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.get("/", (_req: Request, res: Response) => {
    res.type("html").send(studioPage());
  });

  // Catálogo de helpers para o menu "Inserir função" do editor.
  app.get("/api/helpers", (_req: Request, res: Response) => {
    res.json(REPORT_HELPER_DOCS);
  });

  app.post("/api/fetch-data", async (req: Request, res: Response) => {
    const { url, headers, filters } = req.body ?? {};
    if (!url) {
      res.status(400).json({ message: "Informe a URL da rota de dados do app." });
      return;
    }
    try {
      const response = await fetch(String(url), {
        method: "POST",
        headers: { "content-type": "application/json", ...parseHeaders(headers) },
        body: JSON.stringify(filters ?? {}),
      });
      const body = await response.text();
      res
        .status(response.status)
        .type(response.headers.get("content-type") ?? "application/json")
        .send(body);
    } catch (error: any) {
      res.status(502).json({ message: `Falha ao buscar dados no app: ${error?.message ?? error}` });
    }
  });

  app.post("/api/render", (req: Request, res: Response) => {
    const { template, data, partials } = req.body ?? {};
    try {
      const hbs = Handlebars.create();
      registerDefaultReportHelpers(hbs);
      for (const [name, content] of Object.entries((partials as Record<string, string>) ?? {})) {
        hbs.registerPartial(name, String(content ?? ""));
      }
      // Partial padrão para templates que usam {{> assinaturas}} sem fornecê-lo.
      if (!(partials as any)?.assinaturas) hbs.registerPartial("assinaturas", "");
      const html = hbs.compile(String(template ?? ""))(data ?? {});
      res.json({ html });
    } catch (error: any) {
      res.status(422).json({ message: error?.message ?? "Erro ao compilar o template." });
    }
  });

  app.post("/api/export", async (req: Request, res: Response) => {
    const { url, headers, name, content } = req.body ?? {};
    if (!url || !name || !content) {
      res.status(400).json({ message: "url, name e content são obrigatórios." });
      return;
    }
    try {
      const response = await fetch(String(url), {
        method: "POST",
        headers: { "content-type": "application/json", ...parseHeaders(headers) },
        body: JSON.stringify({ name, content }),
      });
      const body = await response.text();
      res
        .status(response.status)
        .type(response.headers.get("content-type") ?? "application/json")
        .send(body);
    } catch (error: any) {
      res.status(502).json({ message: `Falha ao exportar template: ${error?.message ?? error}` });
    }
  });

  await new Promise<void>((resolve) => {
    app.listen(port, () => resolve());
  });
}
