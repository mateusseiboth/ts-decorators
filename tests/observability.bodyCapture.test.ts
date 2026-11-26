import { afterEach, describe, expect, test } from "bun:test";

import { Auditable, resetAuditStorage, setAuditStorage } from "../src/decorators/auditable";
import { isBodyCaptureMarked, markBodyCapture } from "../src/observability/bodyCapture";
import { fakeClassContext, mockReq, mockRes } from "./_helpers";

describe("marca de corpo inteiro no span", () => {
  afterEach(() => resetAuditStorage());

  test("requisição sem marca não grava corpo", () => {
    expect(isBodyCaptureMarked(mockReq())).toBe(false);
  });

  test("markBodyCapture marca só aquela requisição", () => {
    const marcada = mockReq();
    markBodyCapture(marcada);
    expect(isBodyCaptureMarked(marcada)).toBe(true);
    expect(isBodyCaptureMarked(mockReq())).toBe(false);
  });

  test("valor que não é objeto é ignorado, sem lançar", () => {
    expect(() => markBodyCapture(undefined as any)).not.toThrow();
    expect(isBodyCaptureMarked(undefined as any)).toBe(false);
  });

  test("a escrita de um controller @Auditable marca a requisição", async () => {
    setAuditStorage(async () => {});
    class ImovelController {
      DAO = { tx: null };
      async create(_req: any, res: any) {
        return res.json({ data: { id: "1" } });
      }
      async get(_req: any, res: any) {
        return res.json([]);
      }
    }
    Auditable({ captureBefore: false })(ImovelController, fakeClassContext("ImovelController"));
    const controller = new ImovelController();

    const escrita = mockReq({ body: { inscricao: "01" } });
    await controller.create(escrita, mockRes());
    const listagem = mockReq();
    await controller.get(listagem, mockRes());

    expect(isBodyCaptureMarked(escrita)).toBe(true);
    // A listagem não é auditada: o corpo dela (dado pessoal em volume) não vai para o span.
    expect(isBodyCaptureMarked(listagem)).toBe(false);
  });
});
