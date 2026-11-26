import { afterEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";

import {
  BODY_OMITIDO,
  buildHeaderAttributes,
  isIgnoredPath,
  isIgnoredRequest,
  readRequestId,
  readRoute,
  serializeBody,
  setIgnoredPaths,
} from "../src/observability/httpAttributes";

describe("corpo no span", () => {
  test("objeto vira JSON com credenciais mascaradas, em qualquer profundidade", () => {
    const corpo = serializeBody(
      { nome: "Ana", senha: "x", itens: [{ token: "t" }] },
      undefined,
      1024,
    );
    expect(JSON.parse(corpo)).toEqual({
      nome: "Ana",
      senha: "[redacted]",
      itens: [{ token: "[redacted]" }],
    });
  });

  test("texto JSON é lido e mascarado do mesmo jeito", () => {
    const corpo = serializeBody('{"password":"p","a":1}', "application/json; charset=utf-8", 1024);
    expect(JSON.parse(corpo)).toEqual({ password: "[redacted]", a: 1 });
  });

  test("corpo grande vai INTEIRO enquanto couber no teto", () => {
    const texto = "x".repeat(50_000);
    expect(serializeBody({ texto }, undefined, 1_048_576)).toHaveLength(50_000 + 12);
  });

  test("acima do teto, corta e diz quanto tinha", () => {
    const corpo = serializeBody("é".repeat(100), "text/plain", 50);
    expect(Buffer.byteLength(corpo)).toBeLessThanOrEqual(50 + 40);
    expect(corpo).toContain("[truncado: 200 bytes]");
  });

  test.each([
    ["Buffer", Buffer.from("abc"), undefined],
    ["Uint8Array", new Uint8Array([1, 2]), undefined],
    ["stream", Readable.from(["a"]), undefined],
    ["PDF", "%PDF-1.7", "application/pdf"],
    ["imagem", "png", "image/png"],
    ["octet-stream", "bin", "application/octet-stream"],
  ])("binário ou stream (%s) não entra", (_nome, corpo, tipo) => {
    expect(serializeBody(corpo, tipo, 1024)).toBe(BODY_OMITIDO);
  });

  test("sem corpo, texto vazio", () => {
    expect(serializeBody(undefined, undefined, 1024)).toBe("");
  });
});

describe("headers no span", () => {
  test("todos entram, os sensíveis mascarados", () => {
    expect(
      buildHeaderAttributes("http.request.header", {
        authorization: "Bearer x",
        cookie: "a=b",
        "x-api-key": "k",
        "x-drain-token": "d",
        "proxy-authorization": "p",
        "x-refresh-token": "r",
        accept: "application/json",
        "x-multi": ["a", "b"],
      }),
    ).toEqual({
      "http.request.header.authorization": "[redacted]",
      "http.request.header.cookie": "[redacted]",
      "http.request.header.x-api-key": "[redacted]",
      "http.request.header.x-drain-token": "[redacted]",
      "http.request.header.proxy-authorization": "[redacted]",
      "http.request.header.x-refresh-token": "[redacted]",
      "http.request.header.accept": "application/json",
      "http.request.header.x-multi": "a, b",
    });
  });

  test("set-cookie da resposta também", () => {
    expect(buildHeaderAttributes("http.response.header", { "set-cookie": ["s=1"] })).toEqual({
      "http.response.header.set-cookie": "[redacted]",
    });
  });
});

describe("rota", () => {
  test("baseUrl + path da rota casada", () => {
    expect(readRoute({ baseUrl: "/api/v1/imoveis", route: { path: "/:id" } } as any)).toBe(
      "/api/v1/imoveis/:id",
    );
  });

  test("rota raiz de um router não deixa barra sobrando", () => {
    expect(readRoute({ baseUrl: "/api/imoveis", route: { path: "/" } } as any)).toBe(
      "/api/imoveis",
    );
    expect(readRoute({ baseUrl: "", route: { path: "/" } } as any)).toBe("/");
  });

  test("sem rota casada (404), nunca o path cru", () => {
    expect(readRoute({ baseUrl: "", path: "/qualquer/123" } as any)).toBe("(sem rota)");
  });

  test("rota em expressão regular vira texto", () => {
    expect(readRoute({ baseUrl: "", route: { path: /^\/x$/ } } as any)).toBe("/^\\/x$/");
  });
});

describe("caminhos fora da observação", () => {
  test.each(["/health", "/health/ready", "/internal/drain", "/internal/drain/status", "/metrics"])(
    "%s fica fora",
    (caminho) => expect(isIgnoredPath(caminho)).toBe(true),
  );

  test.each(["/api/health-plan", "/metricsx", "/api/imoveis"])("%s é observado", (caminho) =>
    expect(isIgnoredPath(caminho)).toBe(false),
  );
});

describe("caminhos fora do trace (ignoreIncomingRequestHook da instrumentation-http)", () => {
  afterEach(() => setIgnoredPaths());

  test("a lista padrão vale para a URL crua, com query", () => {
    expect(isIgnoredRequest({ url: "/health/ready?x=1" })).toBe(true);
    expect(isIgnoredRequest({ url: "/metrics" })).toBe(true);
    expect(isIgnoredRequest({ url: "/api/imoveis?x=1" })).toBe(false);
  });

  test("os ignorePaths do observeHttp substituem a lista, e sem argumento ela volta", () => {
    setIgnoredPaths([/^\/status/]);
    expect(isIgnoredRequest({ url: "/status" })).toBe(true);
    expect(isIgnoredRequest({ url: "/health" })).toBe(false);
    setIgnoredPaths();
    expect(isIgnoredRequest({ url: "/health" })).toBe(true);
  });

  test("sem url, observa", () => {
    expect(isIgnoredRequest({})).toBe(false);
  });
});

describe("id da requisição", () => {
  test("o x-request-id que chegou é mantido", () => {
    expect(readRequestId({ "x-request-id": "abc-123" })).toBe("abc-123");
  });

  test("sem header, um uuid v7 novo", () => {
    expect(readRequestId({})).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("header com caractere de controle ou comprido demais é trocado", () => {
    expect(readRequestId({ "x-request-id": "a\nb" })).not.toBe("a\nb");
    expect(readRequestId({ "x-request-id": "x".repeat(200) })).toHaveLength(36);
  });
});
