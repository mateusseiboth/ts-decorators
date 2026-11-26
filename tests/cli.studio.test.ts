import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "http";

import express from "express";

import {
  StudioPdfUnavailableError,
  startStudioServer,
  type StudioPdfOptions,
  type StudioServer,
} from "../src/studio/server";

let studio: StudioServer;
let base = "";
let mockApp: Server | undefined;
let appBase = "";
const received: any[] = [];
const pdfCalls: { html: string; options: StudioPdfOptions }[] = [];
let pdfUnavailable = false;

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const connection = () => ({
  baseUrl: `${appBase}/relatorio/api/`,
  reportId: "rep-1",
  headers: { authorization: "Bearer tok-123", vazio: "" },
});

beforeAll(async () => {
  studio = await startStudioServer({
    port: 0,
    renderPdf: async (html, options) => {
      if (pdfUnavailable) throw new StudioPdfUnavailableError();
      pdfCalls.push({ html, options });
      return new TextEncoder().encode("%PDF-1.7 fake");
    },
  });
  base = studio.url.replace(/\/$/, "");

  // App alvo fake: as rotas do createReportRouter que o Studio usa.
  const app = express();
  app.use(express.json());
  app.post("/relatorio/api/data/rep-1", (req, res) => {
    received.push({ route: "data", auth: req.headers.authorization, body: req.body });
    res.json({ title: "Do App", items: [{ nome: "A", valor: 3 }] });
  });
  app.get("/relatorio/api/templates/rep-1", (_req, res) => {
    res.json({ data: [{ id: "t1", name: "Modelo", content: "<b>x</b>", active: true }] });
  });
  app.post("/relatorio/api/templates/rep-1", (req, res) => {
    received.push({ route: "save", body: req.body });
    res.status(201).json({ data: { id: "t2", ...req.body } });
  });
  app.put("/relatorio/api/templates/rep-1/active/:id", (req, res) => {
    received.push({ route: "activate", id: req.params.id });
    res.json({ message: "Template ativado." });
  });
  app.delete("/relatorio/api/templates/rep-1/active", (_req, res) => {
    received.push({ route: "restore" });
    res.json({ message: "Template padrão restaurado." });
  });
  await new Promise<void>((resolve) => {
    mockApp = app.listen(0, resolve);
  });
  appBase = `http://localhost:${(mockApp!.address() as { port: number }).port}`;
});

afterAll(async () => {
  mockApp?.close();
  await studio.stop();
});

describe("Studio: página", () => {
  test("GET / serve o editor com prévia, problemas e paleta de comandos", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("ts-decorators Studio");
    for (const id of [
      "editor",
      "editorHl",
      "gutter",
      "dataTree",
      "problems",
      "palette",
      "preview",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    // Templates de relatório carregam <script> próprios: sem a permissão o Chrome bloqueia.
    expect(html).toMatch(/sandbox="[^"]*allow-scripts allow-same-origin/);
  });

  test("o cliente em TypeScript é empacotado e servido", async () => {
    const html = await (await fetch(`${base}/`)).text();
    const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    expect(script).toBeDefined();
    const res = await fetch(new URL(script!, `${base}/`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/api/render");
  });
});

describe("Studio: porta", () => {
  // Sem isso o Linux divide as requisições entre o Studio velho e o novo, em silêncio.
  test("não sobe um segundo Studio na porta ocupada", async () => {
    const port = Number(new URL(base).port);
    await expect(startStudioServer({ port })).rejects.toThrow();
  });
});

describe("Studio: catálogos", () => {
  test("GET /api/helpers devolve o catálogo para o menu de funções", async () => {
    const helpers = (await (await fetch(`${base}/api/helpers`)).json()) as any[];
    const names = helpers.map((h) => h.name);
    expect(names).toContain("sum");
    expect(names).toContain("ifCond");
    for (const helper of helpers) {
      expect(helper.description.length).toBeGreaterThan(0);
      expect(helper.snippet).toContain("{{");
    }
  });

  test("GET /api/starters devolve os modelos prontos com dados de exemplo", async () => {
    const starters = (await (await fetch(`${base}/api/starters`)).json()) as any[];
    expect(starters.length).toBeGreaterThanOrEqual(4);
    for (const starter of starters) {
      expect(starter.id).toBeString();
      expect(starter.name).toBeString();
      expect(starter.template).toBeString();
      expect(starter.sampleData).toBeObject();
    }
  });
});

describe("Studio: render", () => {
  test("compila com os helpers do worker e informa o tempo", async () => {
    const res = await post("/api/render", {
      template:
        '<p>{{title}}: {{currency (sum itens "valor")}} {{#ifCond status "==" "ATIVO"}}Ativo{{/ifCond}}</p>',
      data: { title: "Prévia", status: "ATIVO", itens: [{ valor: 10 }, { valor: 5.5 }] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.html).toContain("Prévia");
    expect(body.html).toContain("15,50");
    expect(body.html).toContain("Ativo");
    expect(body.ms).toBeNumber();
  });

  test("sem o bloco de assinaturas, a prévia mostra onde ele entra", async () => {
    const body = (await (
      await post("/api/render", { template: "{{> assinaturas}}" })
    ).json()) as any;
    expect(body.html).toContain("Assinaturas");
  });

  test("assinaturas enviadas pela tela vencem o marcador", async () => {
    const res = await post("/api/render", {
      template: "{{> assinaturas}}",
      partials: { assinaturas: "<i>Fulano</i>" },
    });
    expect(((await res.json()) as any).html).toBe("<i>Fulano</i>");
  });

  test("erro de sintaxe → 422 com mensagem e linha", async () => {
    const res = await post("/api/render", { template: "a\n{{#each itens}}" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.message).toContain("não foi fechado");
    expect(body.line).toBe(2);
  });
});

describe("Studio: lint", () => {
  test("acusa função inexistente e campo fora dos dados", async () => {
    const res = await post("/api/lint", {
      template: "{{moeda total}}\n{{titlo}}\n{{currency total}}{{> assinaturas}}",
      data: { total: 1, titulo: "x" },
    });
    expect(res.status).toBe(200);
    const { problems } = (await res.json()) as any;
    expect(problems).toEqual([
      { severity: "error", message: "A função moeda não existe.", line: 1, column: 3 },
      {
        severity: "warning",
        message: "O campo titlo não existe nos dados carregados.",
        line: 2,
        column: 3,
      },
    ]);
  });
});

describe("Studio: PDF", () => {
  test("gera o PDF do modelo renderizado no formato escolhido", async () => {
    const res = await post("/api/pdf", {
      template: "<h1>{{titulo}}</h1>",
      data: { titulo: "Folha" },
      pageFormat: "A3",
      landscape: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(await res.text()).toStartWith("%PDF");
    expect(pdfCalls.at(-1)).toEqual({
      html: "<h1>Folha</h1>",
      options: { pageFormat: "A3", landscape: true },
    });
  });

  test("formato inválido cai no A4 retrato", async () => {
    await post("/api/pdf", { template: "x", pageFormat: "Guardanapo" });
    expect(pdfCalls.at(-1)!.options).toEqual({ pageFormat: "A4", landscape: false });
  });

  test("sem o playwright instalado → 501 com o que fazer", async () => {
    pdfUnavailable = true;
    const res = await post("/api/pdf", { template: "x" });
    pdfUnavailable = false;
    expect(res.status).toBe(501);
    expect(((await res.json()) as any).message).toContain("playwright");
  });

  test("erro no modelo não chega ao navegador", async () => {
    const before = pdfCalls.length;
    const res = await post("/api/pdf", { template: "{{#each}}" });
    expect(res.status).toBe(422);
    expect(pdfCalls.length).toBe(before);
  });
});

describe("Studio: conexão com o sistema", () => {
  test("data: busca os dados tratados com os headers e filtros do usuário", async () => {
    const res = await post("/api/app/data", { connection: connection(), filters: { ano: 2026 } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).title).toBe("Do App");
    expect(received.find((r) => r.route === "data")).toEqual({
      route: "data",
      auth: "Bearer tok-123",
      body: { ano: 2026 },
    });
  });

  test("templates: lista os modelos do relatório", async () => {
    const res = await post("/api/app/templates", { connection: connection() });
    expect(((await res.json()) as any).data[0]).toMatchObject({ id: "t1", active: true });
  });

  test("save-template: publica o modelo", async () => {
    const res = await post("/api/app/save-template", {
      connection: connection(),
      name: "Modelo Studio",
      content: "<b>{{title}}</b>",
    });
    expect(res.status).toBe(201);
    expect(received.find((r) => r.route === "save").body).toEqual({
      name: "Modelo Studio",
      content: "<b>{{title}}</b>",
    });
  });

  test("activate-template: ativa um modelo ou volta ao padrão", async () => {
    await post("/api/app/activate-template", { connection: connection(), templateId: "t1" });
    await post("/api/app/activate-template", { connection: connection(), templateId: null });
    expect(received.filter((r) => r.route === "activate" || r.route === "restore")).toEqual([
      { route: "activate", id: "t1" },
      { route: "restore" },
    ]);
  });

  test("sem endereço ou relatório → 400", async () => {
    const res = await post("/api/app/data", { connection: { baseUrl: "", reportId: "" } });
    expect(res.status).toBe(400);
  });

  test("ação desconhecida → 404", async () => {
    const res = await post("/api/app/apagar-tudo", { connection: connection() });
    expect(res.status).toBe(404);
  });

  test("sistema fora do ar → 502", async () => {
    const res = await post("/api/app/data", {
      connection: { baseUrl: "http://127.0.0.1:1", reportId: "rep-1" },
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).message).toContain("sistema");
  });
});

describe("Studio: sistemas permitidos", () => {
  test("com allowedOrigins, só conversa com os sistemas da lista", async () => {
    const locked = await startStudioServer({ port: 0, allowedOrigins: [appBase] });
    const call = (baseUrl: string) =>
      fetch(`${locked.url}api/app/templates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connection: { baseUrl, reportId: "rep-1" } }),
      });
    try {
      expect((await call(`${appBase}/relatorio/api`)).status).toBe(200);
      const blocked = await call("http://169.254.169.254/latest");
      expect(blocked.status).toBe(403);
      expect(((await blocked.json()) as any).message).toContain("169.254.169.254");
    } finally {
      await locked.stop();
    }
  });
});
