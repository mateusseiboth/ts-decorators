import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { loadReportHeaderImage } from "../src/report/worker/headerImage";

/**
 * O brasão é enfeite do cabeçalho: falhar ao baixá-lo NÃO pode impedir o relatório.
 * Qualquer falha (HTTP de erro, arquivo grande demais, rede fora) devolve `null` e
 * avisa pelo `onFailure`; o worker segue e o relatório sai sem brasão.
 */
const PNG_64x48 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAQ0lEQVRo3u3PQQkAAAgEsEty/aMYywp+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBqwWJJzC1rWH8dQAAAABJRU5ErkJggg==",
  "base64",
);

const rotas: Record<string, () => Response> = {
  "/brasao.png": () => new Response(PNG_64x48, { headers: { "content-type": "image/png" } }),
  "/ausente.png": () => new Response("não encontrado", { status: 404 }),
  "/enorme.png": () =>
    new Response(Buffer.alloc(4096), { headers: { "content-type": "image/png" } }),
};

let server: ReturnType<typeof Bun.serve>;
const urlDe = (caminho: string): string => new URL(caminho, server.url).href;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => (rotas[new URL(req.url).pathname] ?? rotas["/ausente.png"])(),
  });
});

afterAll(() => {
  server.stop(true);
});

const collectFalhas = () => {
  const falhas: string[] = [];
  return { falhas, onFailure: (erro: Error) => falhas.push(erro.message) };
};

describe("loadReportHeaderImage", () => {
  test("baixa e comprime o brasão", async () => {
    const { falhas, onFailure } = collectFalhas();

    const imagem = await loadReportHeaderImage(urlDe("/brasao.png"), { onFailure });

    expect(imagem).not.toBeNull();
    expect(imagem?.originalBytes).toBe(PNG_64x48.length);
    expect(imagem?.buffer.length).toBeGreaterThan(0);
    expect(falhas).toEqual([]);
  });

  test("HTTP de erro: devolve null e avisa, sem lançar", async () => {
    const { falhas, onFailure } = collectFalhas();

    const imagem = await loadReportHeaderImage(urlDe("/ausente.png"), { onFailure });

    expect(imagem).toBeNull();
    expect(falhas).toHaveLength(1);
    expect(falhas[0]).toContain("HTTP 404");
  });

  test("acima do limite: devolve null e avisa, sem lançar", async () => {
    const { falhas, onFailure } = collectFalhas();

    const imagem = await loadReportHeaderImage(urlDe("/enorme.png"), {
      maxBytes: 1024,
      onFailure,
    });

    expect(imagem).toBeNull();
    expect(falhas).toHaveLength(1);
    expect(falhas[0]).toContain("excede o limite");
  });

  test("servidor fora do ar: devolve null e avisa, sem lançar", async () => {
    const { falhas, onFailure } = collectFalhas();

    const imagem = await loadReportHeaderImage("http://127.0.0.1:1/brasao.png", { onFailure });

    expect(imagem).toBeNull();
    expect(falhas).toHaveLength(1);
  });
});
