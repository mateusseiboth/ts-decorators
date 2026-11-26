import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AuditLogger } from "../src/storage/AuditLogger";

const at = (iso: string) => setSystemTime(new Date(iso));

describe("AuditLogger: rotação e retenção", () => {
  let dir: string;
  let basePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tsd-audit-rot-"));
    basePath = path.join(dir, "audit.db");
    AuditLogger.reset();
  });

  afterEach(() => {
    AuditLogger.reset();
    setSystemTime();
    rmSync(dir, { recursive: true, force: true });
  });

  function urlsOf(file: string): string[] {
    const db = new Database(path.join(dir, file), { readonly: true });
    const rows = db.query("SELECT url FROM audit_logs ORDER BY rowid").all() as { url: string }[];
    db.close();
    return rows.map((r) => r.url);
  }

  const dbFiles = () =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".db"))
      .sort();

  const entry = (url: string, method = "POST") => ({ method, url, responseBody: { ok: true } });

  test("por padrão, um arquivo por mês ao lado do caminho configurado", () => {
    at("2026-11-05T12:00:00");
    AuditLogger.configure({ path: basePath });
    const logger = AuditLogger.getInstance();
    logger.log(entry("/a"));
    logger.flush();

    expect(dbFiles()).toEqual(["audit-2026-11.db"]);
    expect(urlsOf("audit-2026-11.db")).toEqual(["/a"]);
  });

  test("rotate: daily usa um arquivo por dia", () => {
    at("2026-11-05T12:00:00");
    AuditLogger.configure({ path: basePath, rotate: "daily" });
    const logger = AuditLogger.getInstance();
    logger.log(entry("/a"));
    logger.flush();

    expect(dbFiles()).toEqual(["audit-2026-11-05.db"]);
  });

  test("rotate: none mantém o arquivo único de antes", () => {
    at("2026-11-05T12:00:00");
    AuditLogger.configure({ path: basePath, rotate: "none" });
    const logger = AuditLogger.getInstance();
    logger.log(entry("/a"));
    logger.flush();

    expect(dbFiles()).toEqual(["audit.db"]);
  });

  test("a virada do mês no meio do lote: cada entrada vai para o arquivo do momento em que foi registrada", () => {
    at("2026-10-31T23:59:59");
    AuditLogger.configure({ path: basePath, flushIntervalMs: 60_000 });
    const logger = AuditLogger.getInstance();
    logger.log(entry("/outubro"));
    at("2026-11-01T00:00:01");
    logger.log(entry("/novembro"));
    logger.flush();
    logger.log(entry("/novembro-2"));
    logger.flush();

    expect(dbFiles()).toEqual(["audit-2026-10.db", "audit-2026-11.db"]);
    expect(urlsOf("audit-2026-10.db")).toEqual(["/outubro"]);
    expect(urlsOf("audit-2026-11.db")).toEqual(["/novembro", "/novembro-2"]);
  });

  test("a retenção apaga os meses além do limite, contando o atual", () => {
    for (const mes of ["2026-07", "2026-08", "2026-09", "2026-10"]) {
      writeFileSync(path.join(dir, `audit-${mes}.db`), "");
    }
    writeFileSync(path.join(dir, "audit-2026-08.db-wal"), "");
    writeFileSync(path.join(dir, "outro-2020-01.db"), "");

    at("2026-11-05T12:00:00");
    AuditLogger.configure({ path: basePath, retention: 3 });
    AuditLogger.getInstance().log(entry("/a"));
    AuditLogger.getInstance().flush();

    expect(dbFiles()).toEqual([
      "audit-2026-09.db",
      "audit-2026-10.db",
      "audit-2026-11.db",
      "outro-2020-01.db",
    ]);
    expect(existsSync(path.join(dir, "audit-2026-08.db-wal"))).toBe(false);
  });

  test("a retenção roda de novo na virada do período", () => {
    at("2026-10-15T12:00:00");
    AuditLogger.configure({ path: basePath, retention: 1, flushIntervalMs: 60_000 });
    const logger = AuditLogger.getInstance();
    logger.log(entry("/outubro"));
    logger.flush();
    at("2026-11-01T00:00:01");
    logger.log(entry("/novembro"));
    logger.flush();

    expect(dbFiles()).toEqual(["audit-2026-11.db"]);
  });

  test("retenção padrão: 12 meses no mensal", () => {
    writeFileSync(path.join(dir, "audit-2025-11.db"), "");
    writeFileSync(path.join(dir, "audit-2025-12.db"), "");
    at("2026-11-05T12:00:00");
    AuditLogger.configure({ path: basePath });
    AuditLogger.getInstance();

    expect(dbFiles()).toEqual(["audit-2025-12.db", "audit-2026-11.db"]);
  });

  test("retenção padrão: 90 dias no diário", () => {
    writeFileSync(path.join(dir, "audit-2026-08-07.db"), "");
    writeFileSync(path.join(dir, "audit-2026-08-08.db"), "");
    at("2026-11-05T12:00:00");
    AuditLogger.configure({ path: basePath, rotate: "daily" });
    AuditLogger.getInstance();

    expect(dbFiles()).toEqual(["audit-2026-08-08.db", "audit-2026-11-05.db"]);
  });

  test("retention: Infinity não apaga nada", () => {
    writeFileSync(path.join(dir, "audit-2001-01.db"), "");
    at("2026-11-05T12:00:00");
    AuditLogger.configure({ path: basePath, retention: Infinity });
    AuditLogger.getInstance();

    expect(dbFiles()).toEqual(["audit-2001-01.db", "audit-2026-11.db"]);
  });

  test("o audit.db antigo continua lá e legível, até a retenção alcançar a última escrita dele", () => {
    at("2026-11-05T12:00:00");
    AuditLogger.configure({ path: basePath, rotate: "none" });
    AuditLogger.getInstance().log(entry("/legado"));
    AuditLogger.reset();

    AuditLogger.configure({ path: basePath, retention: 2 });
    const logger = AuditLogger.getInstance();
    logger.log(entry("/novo"));
    logger.flush();

    expect(urlsOf("audit.db")).toEqual(["/legado"]);
    expect(logger.listFiles()).toEqual([basePath, path.join(dir, "audit-2026-11.db")]);

    // Sem escrita desde setembro: com retenção de 2 meses (outubro e novembro), sai.
    const setembro = new Date("2026-09-20T12:00:00");
    // A leitura acima deixa o WAL ao lado do arquivo: ele também conta como última escrita.
    for (const file of [basePath, `${basePath}-wal`].filter((f) => existsSync(f))) {
      utimesSync(file, setembro, setembro);
    }
    AuditLogger.reset();
    AuditLogger.configure({ path: basePath, retention: 2 });
    AuditLogger.getInstance();

    expect(dbFiles()).toEqual(["audit-2026-11.db"]);
  });

  test("listFiles lista do mais antigo para o mais novo", () => {
    writeFileSync(path.join(dir, "audit-2026-09.db"), "");
    at("2026-11-05T12:00:00");
    AuditLogger.configure({ path: basePath });
    expect(AuditLogger.getInstance().listFiles()).toEqual([
      path.join(dir, "audit-2026-09.db"),
      path.join(dir, "audit-2026-11.db"),
    ]);
  });

  test("skipResponseBody deixa de gravar o corpo da resposta dos verbos escolhidos", () => {
    at("2026-11-05T12:00:00");
    AuditLogger.configure({ path: basePath, rotate: "none", skipResponseBody: ["GET"] });
    const logger = AuditLogger.getInstance();
    logger.log(entry("/lista", "GET"));
    logger.log(entry("/grava", "POST"));
    logger.flush();

    const db = new Database(basePath, { readonly: true });
    const rows = db.query("SELECT method, response_body FROM audit_logs ORDER BY rowid").all();
    db.close();
    expect(rows).toEqual([
      { method: "GET", response_body: null },
      { method: "POST", response_body: '{"ok":true}' },
    ]);
  });
});
