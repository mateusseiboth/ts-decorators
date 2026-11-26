import { describe, expect, test } from "bun:test";

import { idempotencyMiddleware } from "../src/middlwares/idempotent";
import { mockNext, mockReq, mockRes } from "./_helpers";

interface Pedido {
  method?: string;
  url?: string;
  body?: unknown;
}

/** Escrita por padrão: é nela que o middleware age. */
function reqWith(headers: Record<string, string>, pedido: Pedido = {}): any {
  const url = pedido.url ?? "/empenhos";
  const r = mockReq({
    headers,
    method: pedido.method ?? "POST",
    originalUrl: url,
    url,
    body: pedido.body,
  });
  r.header = (name: string) => headers[name.toLowerCase()];
  return r;
}

describe("idempotencyMiddleware", () => {
  test("400 quando falta a chave, com mensagem em português e código", async () => {
    const mw = idempotencyMiddleware();
    const res = mockRes();
    const next = mockNext();
    await mw(reqWith({}), res, next);
    expect(res.statusCode).toBe(400);
    expect(res._body).toEqual({
      message: "Não foi possível identificar o envio. Atualize a página e tente de novo.",
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
    expect(next.called).toBe(false);
  });

  test("aceita o cabeçalho Idempotency-Key (padrão IETF)", async () => {
    const mw = idempotencyMiddleware({ identify: (r: any) => r.header("authorization") });
    const key = "key-ietf-" + Math.random();

    const res1 = mockRes();
    await mw(reqWith({ "idempotency-key": key, authorization: "tokenA" }), res1, mockNext());
    res1.status(201).json({ id: 7 });

    const res2 = mockRes();
    const next2 = mockNext();
    await mw(reqWith({ "idempotency-key": key, authorization: "tokenA" }), res2, next2);
    expect(next2.called).toBe(false);
    expect(res2.statusCode).toBe(201);
    expect(res2._body).toEqual({ id: 7 });
  });

  test("mesmo dono: reproduz a resposta cacheada", async () => {
    const mw = idempotencyMiddleware({ identify: (r: any) => r.header("authorization") });
    const key = "key-owner-a-" + Math.random();

    // 1ª requisição do dono A
    const req1 = reqWith({ "x-idempotency-key": key, authorization: "tokenA" });
    const res1 = mockRes();
    await mw(req1, res1, mockNext());
    res1.status(201).json({ id: 1 });

    // 2ª requisição do mesmo dono A com a mesma chave → replay
    const req2 = reqWith({ "x-idempotency-key": key, authorization: "tokenA" });
    const res2 = mockRes();
    await mw(req2, res2, mockNext());
    expect(res2.statusCode).toBe(201);
    expect(res2._body).toEqual({ id: 1 });
  });

  test("dono diferente com a mesma chave → 409 (não vaza resposta alheia)", async () => {
    const mw = idempotencyMiddleware({ identify: (r: any) => r.header("authorization") });
    const key = "key-shared-" + Math.random();

    const reqA = reqWith({ "x-idempotency-key": key, authorization: "tokenA" });
    const resA = mockRes();
    await mw(reqA, resA, mockNext());
    resA.status(200).json({ secret: "de A" });

    // Atacante usa a chave de A com outro token
    const reqB = reqWith({ "x-idempotency-key": key, authorization: "tokenB" });
    const resB = mockRes();
    await mw(reqB, resB, mockNext());
    expect(resB.statusCode).toBe(409);
    expect(resB._body).toEqual({
      message: "Este envio pertence a outro usuário. Atualize a página e tente de novo.",
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
  });

  describe("impressão digital da requisição", () => {
    const mw = idempotencyMiddleware({ identify: (r: any) => r.header("authorization") });
    const DIFERENTE = {
      message: "Este envio já foi feito com outros dados. Atualize a página e tente de novo.",
      code: "IDEMPOTENCY_KEY_REUSED",
    };

    async function sendPrimeiro(key: string, pedido: Pedido) {
      const res = mockRes();
      await mw(
        reqWith({ "x-idempotency-key": key, authorization: "tokenA" }, pedido),
        res,
        mockNext(),
      );
      res.status(201).json({ id: 1 });
    }

    test("mesma chave e mesmo corpo, em outra ordem de campos: reproduz", async () => {
      const key = "key-fp-igual-" + Math.random();
      await sendPrimeiro(key, { body: { valor: 10, nome: "A", itens: [{ a: 1, b: 2 }] } });

      const res = mockRes();
      const next = mockNext();
      await mw(
        reqWith(
          { "x-idempotency-key": key, authorization: "tokenA" },
          { body: { itens: [{ b: 2, a: 1 }], nome: "A", valor: 10 } },
        ),
        res,
        next,
      );
      expect(next.called).toBe(false);
      expect(res._body).toEqual({ id: 1 });
    });

    test("mesma chave com corpo diferente: 422 e a rota não roda", async () => {
      const key = "key-fp-corpo-" + Math.random();
      await sendPrimeiro(key, { body: { valor: 10 } });

      const res = mockRes();
      const next = mockNext();
      await mw(
        reqWith({ "x-idempotency-key": key, authorization: "tokenA" }, { body: { valor: 99 } }),
        res,
        next,
      );
      expect(next.called).toBe(false);
      expect(res.statusCode).toBe(422);
      expect(res._body).toEqual(DIFERENTE);
    });

    test("mesma chave em outro caminho ou outro método: 422", async () => {
      const key = "key-fp-rota-" + Math.random();
      await sendPrimeiro(key, { body: { valor: 10 } });

      const outraRota = mockRes();
      await mw(
        reqWith(
          { "x-idempotency-key": key, authorization: "tokenA" },
          { url: "/parcelas", body: { valor: 10 } },
        ),
        outraRota,
        mockNext(),
      );
      expect(outraRota.statusCode).toBe(422);

      const outroMetodo = mockRes();
      await mw(
        reqWith(
          { "x-idempotency-key": key, authorization: "tokenA" },
          { method: "PUT", body: { valor: 10 } },
        ),
        outroMetodo,
        mockNext(),
      );
      expect(outroMetodo.statusCode).toBe(422);
    });
  });

  describe("mode e methods: ligar uma vez para todas as escritas", () => {
    test("mode optional: sem chave a requisição passa sem idempotência", async () => {
      const mw = idempotencyMiddleware({ mode: "optional" });
      const res = mockRes();
      const next = mockNext();
      await mw(reqWith({}), res, next);
      expect(next.called).toBe(true);
      expect(res._body).toBeUndefined();
    });

    test("mode optional com chave continua reproduzindo", async () => {
      const mw = idempotencyMiddleware({ mode: "optional", identify: () => "dono" });
      const key = "key-opcional-" + Math.random();
      const res1 = mockRes();
      await mw(reqWith({ "idempotency-key": key }), res1, mockNext());
      res1.status(201).json({ id: 3 });

      const res2 = mockRes();
      const next2 = mockNext();
      await mw(reqWith({ "idempotency-key": key }), res2, next2);
      expect(next2.called).toBe(false);
      expect(res2._body).toEqual({ id: 3 });
    });

    test("leitura passa direto, mesmo em mode required e sem chave", async () => {
      const mw = idempotencyMiddleware();
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        const res = mockRes();
        const next = mockNext();
        await mw(reqWith({}, { method }), res, next);
        expect(next.called).toBe(true);
        expect(res.statusCode).toBe(200);
      }
    });

    test("POST, PUT, PATCH e DELETE exigem a chave por padrão", async () => {
      const mw = idempotencyMiddleware();
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = mockRes();
        await mw(reqWith({}, { method }), res, mockNext());
        expect(res.statusCode).toBe(400);
      }
    });

    test("methods troca a lista, sem diferenciar maiúsculas", async () => {
      const mw = idempotencyMiddleware({ methods: ["post"] });

      const put = mockRes();
      const nextPut = mockNext();
      await mw(reqWith({}, { method: "PUT" }), put, nextPut);
      expect(nextPut.called).toBe(true);

      const post = mockRes();
      await mw(reqWith({}, { method: "POST" }), post, mockNext());
      expect(post.statusCode).toBe(400);
    });
  });

  test("resposta de erro não é cacheada: a mesma chave roda o handler de novo", async () => {
    const mw = idempotencyMiddleware({ identify: (r: any) => r.header("authorization") });
    const key = "key-erro-" + Math.random();

    // 1ª tentativa: o handler recusa (validação). Nada foi gravado, nada a reproduzir.
    const res1 = mockRes();
    await mw(reqWith({ "x-idempotency-key": key, authorization: "tokenA" }), res1, mockNext());
    res1.status(400).json({ error: "Já existe um Bem com a plaqueta informada." });

    // 2ª tentativa do mesmo dono, com o payload corrigido e a MESMA chave: precisa
    // chegar no handler — replicar o erro anterior deixaria a tela travada até o TTL.
    const res2 = mockRes();
    const next2 = mockNext();
    await mw(reqWith({ "x-idempotency-key": key, authorization: "tokenA" }), res2, next2);

    expect(next2.called).toBe(true);
    expect(res2._body).toBeUndefined();

    res2.status(201).json({ id: 1 });
    expect(res2.statusCode).toBe(201);
  });

  test("erro sem res.json (só finish) também não fica cacheado", async () => {
    const mw = idempotencyMiddleware({ identify: (r: any) => r.header("authorization") });
    const key = "key-erro-finish-" + Math.random();

    const finishHandlers: Array<() => void> = [];
    const res1 = mockRes({
      on(evento: string, handler: () => void) {
        if (evento === "finish") finishHandlers.push(handler);
        return res1;
      },
    });
    await mw(reqWith({ "x-idempotency-key": key, authorization: "tokenA" }), res1, mockNext());
    res1.statusCode = 500;
    for (const handler of finishHandlers) handler();

    const res2 = mockRes();
    const next2 = mockNext();
    await mw(reqWith({ "x-idempotency-key": key, authorization: "tokenA" }), res2, next2);

    expect(next2.called).toBe(true);
    expect(res2.statusCode).toBe(200);
  });

  describe("cliente derruba a conexão antes da resposta", () => {
    function resWithClose() {
      const closeHandlers: Array<() => void> = [];
      const res = mockRes({
        writableEnded: false,
        on(evento: string, handler: () => void) {
          if (evento === "close") closeHandlers.push(handler);
          return res;
        },
      });
      const close = () => {
        for (const handler of closeHandlers) handler();
      };
      return { res, close };
    }

    function captureUnhandledRejections() {
      const rejections: unknown[] = [];
      const listener = (reason: unknown) => rejections.push(reason);
      process.on("unhandledRejection", listener);
      return {
        rejections,
        restore: () => process.off("unhandledRejection", listener),
      };
    }

    const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 10));

    test("sem ninguém esperando a chave, não gera rejeição não tratada", async () => {
      const captured = captureUnhandledRejections();
      const mw = idempotencyMiddleware({ identify: (r: any) => r.header("authorization") });
      const { res, close } = resWithClose();

      await mw(
        reqWith({ "x-idempotency-key": "key-abort-" + Math.random(), authorization: "tokenA" }),
        res,
        mockNext(),
      );
      close();
      await flushMicrotasks();
      captured.restore();

      expect(captured.rejections).toEqual([]);
    });

    test("replay que esperava a requisição abortada responde 409 em vez de derrubar o processo", async () => {
      const captured = captureUnhandledRejections();
      const mw = idempotencyMiddleware({ identify: (r: any) => r.header("authorization") });
      const key = "key-abort-replay-" + Math.random();
      const { res: res1, close } = resWithClose();

      await mw(reqWith({ "x-idempotency-key": key, authorization: "tokenA" }), res1, mockNext());

      const res2 = mockRes();
      const replay = mw(
        reqWith({ "x-idempotency-key": key, authorization: "tokenA" }),
        res2,
        mockNext(),
      );
      close();
      await replay;
      await flushMicrotasks();
      captured.restore();

      expect(captured.rejections).toEqual([]);
      expect(res2.statusCode).toBe(409);
      expect(res2._body).toEqual({
        message: "O envio anterior foi interrompido. Envie de novo.",
        code: "IDEMPOTENCY_REQUEST_ABORTED",
      });
    });
  });
});
