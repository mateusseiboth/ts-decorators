import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "http";

import express from "express";

import { startStudioServer } from "../src/studio/server";

const STUDIO_PORT = 41299;
const base = `http://localhost:${STUDIO_PORT}`;

let mockApp: Server | undefined;
let mockAppPort = 0;
const received: any[] = [];

beforeAll(async () => {
  await startStudioServer(STUDIO_PORT);

  // App alvo fake: rota de dados tratados + rota de templates.
  const app = express();
  app.use(express.json());
  app.post("/relatorio/api/data/rep-1", (req, res) => {
    received.push({ route: "data", headers: req.headers.authorization, body: req.body });
    res.json({ title: "Do App", items: [{ nome: "A", valor: 3 }] });
  });
  app.post("/relatorio/api/templates/rep-1", (req, res) => {
    received.push({ route: "templates", body: req.body });
    res.status(201).json({ data: { id: "t1", ...req.body } });
  });
  await new Promise<void>((resolve) => {
    mockApp = app.listen(0, resolve);
  });
  mockAppPort = (mockApp!.address() as { port: number }).port;
});

afterAll(() => {
  mockApp?.close();
});

describe("ts-decorators Studio", () => {
  test("GET / serve a página do editor", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("ts-decorators Studio");
    expect(html).toContain('id="editor"');
    // Barra de ferramentas e assistentes do editor visual.
    expect(html).toContain('id="toolbar"');
    expect(html).toContain('id="btnWizCond"');
    expect(html).toContain('id="btnWizTable"');
    expect(html).toContain('id="btnWizCalc"');
    expect(html).toContain('id="dlgJson"');
    // Preview precisa executar scripts dos templates (fix do bloqueio de sandbox).
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
    // Overlay de syntax highlight atrás do textarea.
    expect(html).toContain('id="editorHl"');
    expect(html).toContain("tok-hbs");
    // As regex do highlighter atravessam o template literal do TS — o cliente
    // precisa receber \\{ com UMA barra, senão o realce quebra silenciosamente.
    expect(html).toContain("var RE_MASTER = /(\\{\\{[^]*?\\}\\})");
  });

  test("GET /api/helpers devolve o catálogo para o menu de funções", async () => {
    const res = await fetch(`${base}/api/helpers`);
    expect(res.status).toBe(200);
    const helpers = (await res.json()) as any[];
    const names = helpers.map((h) => h.name);
    expect(names).toContain("sum");
    expect(names).toContain("ifCond");
    expect(names).toContain("currency");
    for (const helper of helpers) {
      expect(helper.description.length).toBeGreaterThan(0);
      expect(helper.snippet).toContain("{{");
    }
  });

  test("POST /api/render aceita os helpers de cálculo e condicional dos assistentes", async () => {
    const res = await fetch(`${base}/api/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template:
          'Total: {{currency (sum itens "valor")}} — {{#ifCond status "==" "ATIVO"}}Ativo{{else}}Inativo{{/ifCond}}',
        data: { status: "ATIVO", itens: [{ valor: 10 }, { valor: 5.5 }] },
      }),
    });
    expect(res.status).toBe(200);
    const { html } = (await res.json()) as any;
    expect(html).toContain("15,50");
    expect(html).toContain("Ativo");
  });

  test("POST /api/render compila HBS com os helpers default do worker", async () => {
    const res = await fetch(`${base}/api/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template: "<p>{{title}} — {{currency total}}</p>",
        data: { title: "Preview", total: 12.5 },
      }),
    });
    expect(res.status).toBe(200);
    const { html } = (await res.json()) as any;
    expect(html).toContain("Preview");
    expect(html).toContain("12,50");
  });

  test("template inválido → 422 com a mensagem do Handlebars", async () => {
    const res = await fetch(`${base}/api/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "{{#each}}" }),
    });
    expect(res.status).toBe(422);
  });

  test("POST /api/fetch-data faz proxy para a rota de dados do app com headers do usuário", async () => {
    const res = await fetch(`${base}/api/fetch-data`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://localhost:${mockAppPort}/relatorio/api/data/rep-1`,
        headers: { authorization: "Bearer tok-123" },
        filters: { ano: 2026 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.title).toBe("Do App");
    const call = received.find((r) => r.route === "data");
    expect(call.headers).toBe("Bearer tok-123");
    expect(call.body).toEqual({ ano: 2026 });
  });

  test("POST /api/export publica o template no app alvo", async () => {
    const res = await fetch(`${base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://localhost:${mockAppPort}/relatorio/api/templates/rep-1`,
        headers: {},
        name: "Modelo Studio",
        content: "<b>{{title}}</b>",
      }),
    });
    expect(res.status).toBe(201);
    const call = received.find((r) => r.route === "templates");
    expect(call.body).toEqual({ name: "Modelo Studio", content: "<b>{{title}}</b>" });
  });
});
