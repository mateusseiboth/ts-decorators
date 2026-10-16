import { describe, expect, test } from "bun:test";

import { idempotencyMiddleware } from "../src/middlwares/idempotent";
import { mockNext, mockReq, mockRes } from "./_helpers";

function reqWith(headers: Record<string, string>): any {
  const r = mockReq({ headers });
  r.header = (name: string) => headers[name.toLowerCase()];
  return r;
}

describe("idempotencyMiddleware", () => {
  test("400 quando falta a chave", async () => {
    const mw = idempotencyMiddleware();
    const res = mockRes();
    await mw(reqWith({}), res, mockNext());
    expect(res.statusCode).toBe(400);
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
    expect(resB._body).not.toEqual({ secret: "de A" });
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
    });
  });
});
