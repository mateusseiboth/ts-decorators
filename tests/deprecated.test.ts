import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Deprecated, deprecatedMiddleware } from "../src/decorators/deprecated";
import { captureWarnings, fakeMethodContext, mockNext, mockReq, mockRes } from "./_helpers";

const PASSADO = "2020-01-01T00:00:00Z";
const FUTURO = "2999-01-01T00:00:00Z";

const countAvisos = (warnings: string[], trecho: string) =>
  warnings.filter((w) => w.includes(trecho)).length;

describe("@Deprecated", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    warnCap = captureWarnings();
  });
  afterEach(() => {
    warnCap.restore();
  });

  test("sem since, Deprecation é true; sem sunset e link, nada além dele", async () => {
    class ImovelController {
      @Deprecated()
      async list(_req: any, res: any) {
        return res.json({ ok: true });
      }
    }

    const res = mockRes();
    await new ImovelController().list(mockReq(), res);
    expect(res._headers).toEqual({ Deprecation: "true" });
    expect(res._body).toEqual({ ok: true });
  });

  test("since vira @segundos, sunset vira data HTTP e link vira Link rel=deprecation", async () => {
    class ImovelController {
      @Deprecated({ since: "2026-01-01T00:00:00Z", sunset: FUTURO, link: "https://docs/v2" })
      async list(_req: any, res: any) {
        return res.json({ ok: true });
      }
    }

    const res = mockRes();
    await new ImovelController().list(mockReq(), res);
    expect(res._headers).toEqual({
      Deprecation: "@1767225600",
      Sunset: new Date(FUTURO).toUTCString(),
      Link: '<https://docs/v2>; rel="deprecation"; type="text/html"',
    });
  });

  test("aceita Date em since e sunset", async () => {
    class ImovelController {
      @Deprecated({ since: new Date(0), sunset: new Date(FUTURO) })
      list(_req: any, res: any) {
        return res;
      }
    }

    const res = mockRes();
    new ImovelController().list(mockReq(), res);
    expect(res._headers.Deprecation).toBe("@0");
    expect(res._headers.Sunset).toBe(new Date(FUTURO).toUTCString());
  });

  test("Link é acrescentado ao Link que já existe", () => {
    class ImovelController {
      @Deprecated({ link: "https://docs/v2" })
      list(_req: any, res: any) {
        return res;
      }
    }

    const res = mockRes({
      getHeader: (nome: string) => (nome === "Link" ? "</p2>; rel=next" : undefined),
    });
    new ImovelController().list(mockReq(), res);
    expect(res._headers.Link).toBe(
      '</p2>; rel=next, <https://docs/v2>; rel="deprecation"; type="text/html"',
    );
  });

  test("avisa no log uma vez só por método, com a mensagem", async () => {
    class ImovelController {
      @Deprecated({ message: "use GET /v2/imoveis" })
      async list(_req: any, res: any) {
        return res.json({});
      }
    }

    const controller = new ImovelController();
    await controller.list(mockReq(), mockRes());
    await controller.list(mockReq(), mockRes());
    expect(countAvisos(warnCap.warnings, "ImovelController.list")).toBe(1);
    expect(countAvisos(warnCap.warnings, "use GET /v2/imoveis")).toBe(1);
  });

  test("blockAfterSunset depois do sunset responde 410 e não executa", async () => {
    let executou = false;
    class ImovelController {
      @Deprecated({ sunset: PASSADO, blockAfterSunset: true })
      async list(_req: any, res: any) {
        executou = true;
        return res.json({});
      }
    }

    const res = mockRes();
    await new ImovelController().list(mockReq(), res);
    expect(executou).toBe(false);
    expect(res.statusCode).toBe(410);
    expect(typeof res._body.message).toBe("string");
    expect(res._body.message).not.toContain("—");
    expect(res._headers.Sunset).toBe(new Date(PASSADO).toUTCString());
  });

  test("blockAfterSunset antes do sunset executa normalmente", async () => {
    class ImovelController {
      @Deprecated({ sunset: FUTURO, blockAfterSunset: true })
      async list(_req: any, res: any) {
        return res.json({ ok: true });
      }
    }

    const res = mockRes();
    await new ImovelController().list(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res._body).toEqual({ ok: true });
  });

  test("sem blockAfterSunset, o sunset vencido só sinaliza", async () => {
    class ImovelController {
      @Deprecated({ sunset: PASSADO })
      async list(_req: any, res: any) {
        return res.json({ ok: true });
      }
    }

    const res = mockRes();
    await new ImovelController().list(mockReq(), res);
    expect(res._body).toEqual({ ok: true });
  });

  test("método comum (sem Response) só avisa uma vez e devolve o retorno", () => {
    class Calculo {
      @Deprecated({ message: "use calcularIptuV2" })
      calcularIptu(valor: number) {
        return valor * 2;
      }
    }

    const calculo = new Calculo();
    expect(calculo.calcularIptu(2)).toBe(4);
    expect(calculo.calcularIptu(3)).toBe(6);
    expect(countAvisos(warnCap.warnings, "Calculo.calcularIptu")).toBe(1);
  });

  test("data inválida lança na hora de decorar", () => {
    expect(() => Deprecated({ sunset: "amanhã" })).toThrow("sunset");
    expect(() => Deprecated({ since: new Date("x") })).toThrow("since");
  });

  test("TC39: envolve o método recebido com o contexto", () => {
    class ImovelController {}
    const list = (_req: unknown, res: unknown) => res;

    const envolvido = Deprecated()(list, fakeMethodContext("list"));
    const res = mockRes();
    expect(envolvido.call(new ImovelController(), mockReq(), res)).toBe(res);
    expect(res._headers.Deprecation).toBe("true");
  });
});

describe("deprecatedMiddleware", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    warnCap = captureWarnings();
  });
  afterEach(() => {
    warnCap.restore();
  });

  test("marca a resposta e segue para a rota", () => {
    const middleware = deprecatedMiddleware({ sunset: FUTURO, link: "https://docs/v2" });
    const res = mockRes();
    const next = mockNext();
    middleware(mockReq(), res, next);
    expect(next.called).toBe(true);
    expect(next.error).toBeUndefined();
    expect(res._headers.Deprecation).toBe("true");
    expect(res._headers.Sunset).toBe(new Date(FUTURO).toUTCString());
  });

  test("depois do sunset com blockAfterSunset responde 410 sem chamar next", () => {
    const middleware = deprecatedMiddleware({ sunset: PASSADO, blockAfterSunset: true });
    const res = mockRes();
    const next = mockNext();
    middleware(mockReq(), res, next);
    expect(next.called).toBe(false);
    expect(res.statusCode).toBe(410);
  });

  test("avisa uma vez por rota", () => {
    const middleware = deprecatedMiddleware({ message: "use /v2" });
    const rotaA = () => mockReq({ baseUrl: "/v1", route: { path: "/imoveis" } });
    const rotaB = () => mockReq({ baseUrl: "/v1", route: { path: "/contribuintes" } });
    middleware(rotaA(), mockRes(), mockNext());
    middleware(rotaA(), mockRes(), mockNext());
    middleware(rotaB(), mockRes(), mockNext());
    expect(countAvisos(warnCap.warnings, "/v1/imoveis")).toBe(1);
    expect(countAvisos(warnCap.warnings, "/v1/contribuintes")).toBe(1);
  });

  test("data inválida lança ao montar o middleware", () => {
    expect(() => deprecatedMiddleware({ since: "ontem" })).toThrow("since");
  });
});
