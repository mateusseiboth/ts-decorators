import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Field, InitFields } from "../src/decorators/initFields";
import { AuditLogger } from "../src/storage/AuditLogger";

describe("AuditLogger", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tsd-audit-"));
    dbPath = path.join(dir, "audit.db");
    AuditLogger.reset();
    AuditLogger.configure({ path: dbPath, rotate: "none", flushIntervalMs: 5 });
  });

  afterEach(() => {
    AuditLogger.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  function rows(): any[] {
    const db = new Database(dbPath, { readonly: true });
    const result = db.query("SELECT * FROM audit_logs ORDER BY rowid").all();
    db.close();
    return result;
  }

  const entry = (url: string) => ({
    method: "POST",
    url,
    requestBody: { nome: "Ana", senha: "segredo" },
    statusCode: 201,
  });

  test("log NÃO grava na hora — a escrita é adiada", () => {
    AuditLogger.getInstance().log(entry("/a"));
    expect(rows().length).toBe(0);
  });

  test("flush grava tudo que estava no buffer", () => {
    const logger = AuditLogger.getInstance();
    logger.log(entry("/a"));
    logger.log(entry("/b"));
    logger.flush();

    const all = rows();
    expect(all.length).toBe(2);
    expect(all.map((r) => r.url)).toEqual(["/a", "/b"]);
  });

  test("o flush automático acontece sozinho depois do intervalo", async () => {
    AuditLogger.getInstance().log(entry("/tardio"));
    await new Promise((r) => setTimeout(r, 60));
    expect(rows().length).toBe(1);
  });

  test("campo cifrado de qualquer model (@Field encrypted) é mascarado pelo nome", () => {
    @InitFields
    class CertificadoAuditadoModel {
      @Field({ encrypted: true }) senhaCertificadoAuditado!: string;
    }
    void CertificadoAuditadoModel;

    const logger = AuditLogger.getInstance();
    logger.log({
      method: "POST",
      url: "/certificados",
      requestBody: { nome: "A1", senhaCertificadoAuditado: "aberta" },
    });
    logger.flush();

    const body = JSON.parse(rows()[0].request_body);
    expect(body.senhaCertificadoAuditado).toBe("***");
    expect(body.nome).toBe("A1");
  });

  test("campo sensível continua mascarado", () => {
    const logger = AuditLogger.getInstance();
    logger.log(entry("/a"));
    logger.flush();

    const body = JSON.parse(rows()[0].request_body);
    expect(body.senha).toBe("***");
    expect(body.nome).toBe("Ana");
  });

  test("serializa no enqueue — mutação posterior do body não vaza para o log", () => {
    const logger = AuditLogger.getInstance();
    const body: Record<string, unknown> = { nome: "Ana" };
    logger.log({ method: "POST", url: "/mut", requestBody: body });
    body.nome = "Alterado";
    logger.flush();

    expect(JSON.parse(rows()[0].request_body).nome).toBe("Ana");
  });

  test("o buffer é descarregado ao atingir o lote máximo", () => {
    AuditLogger.reset();
    AuditLogger.configure({ path: dbPath, rotate: "none", flushIntervalMs: 60_000, maxBatch: 3 });
    const logger = AuditLogger.getInstance();
    logger.log(entry("/1"));
    logger.log(entry("/2"));
    expect(rows().length).toBe(0);
    logger.log(entry("/3"));
    expect(rows().length).toBe(3);
  });

  test("flush com o buffer vazio não faz nada nem quebra", () => {
    const logger = AuditLogger.getInstance();
    expect(() => logger.flush()).not.toThrow();
    expect(rows().length).toBe(0);
  });

  test("close descarrega o que sobrou", () => {
    const logger = AuditLogger.getInstance();
    logger.log(entry("/final"));
    logger.close();
    expect(rows().length).toBe(1);
  });

  test("grava as colunas de contexto", () => {
    const logger = AuditLogger.getInstance();
    logger.log({
      method: "GET",
      url: "/ctx",
      entity: 7,
      exercicio: 2026,
      userId: "u1",
      username: "ana",
      requestId: "r1",
      durationMs: 12,
    });
    logger.flush();

    const row = rows()[0];
    expect(row.entity).toBe(7);
    expect(row.exercicio).toBe(2026);
    expect(row.user_id).toBe("u1");
    expect(row.username).toBe("ana");
    expect(row.request_id).toBe("r1");
    expect(row.duration_ms).toBe(12);
  });

  describe("robustez do payload", () => {
    test("BigInt no corpo não derruba a gravação", () => {
      const logger = AuditLogger.getInstance();
      logger.log({ method: "POST", url: "/big", requestBody: { sequencial: BigInt(42) } });
      logger.flush();

      expect(JSON.parse(rows()[0].request_body)).toEqual({ sequencial: "42" });
    });

    test("corpo circular vira marcador, não exceção", () => {
      const logger = AuditLogger.getInstance();
      const circular: any = { nome: "Ana" };
      circular.self = circular;

      expect(() => {
        logger.log({ method: "POST", url: "/circular", requestBody: circular });
        logger.flush();
      }).not.toThrow();

      expect(JSON.parse(rows()[0].request_body)._unserializable).toBe(true);
    });

    test("corpo gigante é truncado — SQLite não aceita TEXT sem limite", () => {
      AuditLogger.reset();
      AuditLogger.configure({
        path: dbPath,
        rotate: "none",
        flushIntervalMs: 60_000,
        maxTextBytes: 500,
      });
      const logger = AuditLogger.getInstance();

      logger.log({ method: "GET", url: "/grande", responseBody: { linhas: "x".repeat(5_000) } });
      logger.flush();

      const gravado = JSON.parse(rows()[0].response_body);
      expect(gravado._truncated).toBe(true);
      expect(gravado.bytes).toBeGreaterThan(500);
      expect(typeof gravado.preview).toBe("string");
    });

    test("corpo dentro do teto não é truncado", () => {
      AuditLogger.reset();
      AuditLogger.configure({
        path: dbPath,
        rotate: "none",
        flushIntervalMs: 60_000,
        maxTextBytes: 5_000,
      });
      const logger = AuditLogger.getInstance();

      logger.log({ method: "GET", url: "/pequeno", responseBody: { ok: true } });
      logger.flush();

      expect(JSON.parse(rows()[0].response_body)).toEqual({ ok: true });
    });

    test("inviteUrl entra na lista de campos mascarados", () => {
      const logger = AuditLogger.getInstance();
      logger.log({ method: "POST", url: "/convite", requestBody: { inviteUrl: "https://x/y" } });
      logger.flush();

      expect(JSON.parse(rows()[0].request_body).inviteUrl).toBe("***");
    });

    test("o id é UUIDv7 — ordenável no tempo, bom para o índice", () => {
      const logger = AuditLogger.getInstance();
      logger.log({ method: "GET", url: "/a" });
      logger.log({ method: "GET", url: "/b" });
      logger.log({ method: "GET", url: "/c" });
      logger.flush();

      const ids = rows().map((r) => r.id as string);
      expect(ids.every((id) => id[14] === "7")).toBe(true);
      expect([...ids].sort()).toEqual(ids);
    });
  });

  describe("chaves sensíveis", () => {
    test("authorization e cookie são mascarados por padrão, inclusive aninhados", () => {
      const logger = AuditLogger.getInstance();
      logger.log({
        method: "POST",
        url: "/proxy",
        requestBody: {
          Authorization: "Bearer abc",
          headers: { cookie: "sid=1", lista: [{ AUTHORIZATION: "Basic x", ok: 1 }] },
        },
        responseBody: { Cookie: "sid=2" },
      });
      logger.flush();

      const row = rows()[0];
      const body = JSON.parse(row.request_body);
      expect(body.Authorization).toBe("***");
      expect(body.headers.cookie).toBe("***");
      expect(body.headers.lista[0].AUTHORIZATION).toBe("***");
      expect(body.headers.lista[0].ok).toBe(1);
      expect(JSON.parse(row.response_body).Cookie).toBe("***");
    });

    test("sensitiveKeys soma chaves às padrão, sem diferenciar maiúsculas", () => {
      AuditLogger.reset();
      AuditLogger.configure({
        path: dbPath,
        rotate: "none",
        flushIntervalMs: 5,
        sensitiveKeys: ["CPF", "chavePix"],
      });
      const logger = AuditLogger.getInstance();
      logger.log({
        method: "POST",
        url: "/pessoas",
        requestBody: {
          cpf: "123",
          dados: { CHAVEPIX: "x@y" },
          senha: "s",
          authorization: "a",
          nome: "Ana",
        },
      });
      logger.flush();

      expect(JSON.parse(rows()[0].request_body)).toEqual({
        cpf: "***",
        dados: { CHAVEPIX: "***" },
        senha: "***",
        authorization: "***",
        nome: "Ana",
      });
    });

    test("sem sensitiveKeys a lista padrão continua valendo inteira", () => {
      const logger = AuditLogger.getInstance();
      const padrao = {
        senha: "1",
        password: "2",
        token: "3",
        secret: "4",
        access_token: "5",
        refresh_token: "6",
        inviteUrl: "7",
        authorization: "8",
        cookie: "9",
      };
      logger.log({ method: "POST", url: "/padrao", requestBody: { ...padrao, cpf: "123" } });
      logger.flush();

      const body = JSON.parse(rows()[0].request_body);
      for (const chave of Object.keys(padrao)) expect(body[chave]).toBe("***");
      expect(body.cpf).toBe("123");
    });

    test("a chave extra de uma configuração não sobra depois do reset", () => {
      AuditLogger.reset();
      AuditLogger.configure({
        path: dbPath,
        rotate: "none",
        flushIntervalMs: 5,
        sensitiveKeys: ["cpf"],
      });
      AuditLogger.getInstance();
      AuditLogger.reset();
      AuditLogger.configure({ path: dbPath, rotate: "none", flushIntervalMs: 5 });

      const logger = AuditLogger.getInstance();
      logger.log({ method: "POST", url: "/depois", requestBody: { cpf: "123" } });
      logger.flush();

      expect(JSON.parse(rows()[0].request_body).cpf).toBe("123");
    });

    test("params e query continuam sem máscara", () => {
      const logger = AuditLogger.getInstance();
      logger.log({
        method: "GET",
        url: "/q",
        requestParams: { token: "p" },
        requestQuery: { authorization: "q" },
      });
      logger.flush();

      const row = rows()[0];
      expect(JSON.parse(row.request_params).token).toBe("p");
      expect(JSON.parse(row.request_query).authorization).toBe("q");
    });
  });

  describe("serialização em uma passada", () => {
    test("mascara em qualquer profundidade, inclusive dentro de array", () => {
      const logger = AuditLogger.getInstance();
      logger.log({
        method: "POST",
        url: "/fundo",
        requestBody: {
          nivel1: { senha: "a", lista: [{ token: "b", ok: 1 }] },
          nome: "Ana",
        },
      });
      logger.flush();

      const body = JSON.parse(rows()[0].request_body);
      expect(body.nivel1.senha).toBe("***");
      expect(body.nivel1.lista[0].token).toBe("***");
      expect(body.nivel1.lista[0].ok).toBe(1);
      expect(body.nome).toBe("Ana");
    });

    test("BigInt vira string mesmo em campo NÃO mascarado", () => {
      const logger = AuditLogger.getInstance();
      logger.log({ method: "GET", url: "/params", requestParams: { id: BigInt(7) } });
      logger.flush();

      expect(JSON.parse(rows()[0].request_params)).toEqual({ id: "7" });
    });

    test("Date sobrevive à máscara — reconstruir a árvore a transformava em {}", () => {
      const logger = AuditLogger.getInstance();
      logger.log({
        method: "GET",
        url: "/data",
        requestBody: { em: new Date("2026-01-02T03:04:05.000Z"), senha: "x" },
      });
      logger.flush();

      const body = JSON.parse(rows()[0].request_body);
      expect(body.em).toBe("2026-01-02T03:04:05.000Z");
      expect(body.senha).toBe("***");
    });

    test("objeto com toJSON próprio é respeitado, não esvaziado", () => {
      const logger = AuditLogger.getInstance();
      class Dinheiro {
        constructor(private readonly centavos: number) {}
        toJSON() {
          return (this.centavos / 100).toFixed(2);
        }
      }
      logger.log({ method: "POST", url: "/valor", requestBody: { total: new Dinheiro(12345) } });
      logger.flush();

      expect(JSON.parse(rows()[0].request_body)).toEqual({ total: "123.45" });
    });

    test("array no topo é preservado", () => {
      const logger = AuditLogger.getInstance();
      logger.log({ method: "POST", url: "/lista", requestBody: [{ senha: "x" }, { a: 1 }] });
      logger.flush();

      expect(JSON.parse(rows()[0].request_body)).toEqual([{ senha: "***" }, { a: 1 }]);
    });
  });
});
