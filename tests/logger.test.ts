import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getLogLevel, logger, setLogLevel } from "../src/functions/logger";
import { captureLogs, captureWarnings } from "./_helpers";

describe("logger", () => {
  let logCap: ReturnType<typeof captureLogs>;
  let warnCap: ReturnType<typeof captureWarnings>;
  const original = getLogLevel();

  beforeEach(() => {
    logCap = captureLogs();
    warnCap = captureWarnings();
  });
  afterEach(() => {
    logCap.restore();
    warnCap.restore();
    setLogLevel(original);
  });

  test("debug fica MUDO no nível padrão (info)", () => {
    setLogLevel("info");
    logger.debug("nao deve aparecer");
    expect(logCap.logs.length).toBe(0);
  });

  test("debug aparece quando o nível é debug", () => {
    setLogLevel("debug");
    logger.debug("aparece");
    expect(logCap.logs.some((l) => l.includes("aparece"))).toBe(true);
  });

  test("info aparece no nível info e some no warn", () => {
    setLogLevel("info");
    logger.info("visivel");
    expect(logCap.logs.some((l) => l.includes("visivel"))).toBe(true);

    logCap.logs.length = 0;
    setLogLevel("warn");
    logger.info("invisivel");
    expect(logCap.logs.length).toBe(0);
  });

  test("silent cala tudo, inclusive warn", () => {
    setLogLevel("silent");
    logger.warn("nada");
    logger.info("nada");
    logger.debug("nada");
    expect(logCap.logs.length).toBe(0);
    expect(warnCap.warnings.length).toBe(0);
  });

  test("mensagem lazy NÃO é construída quando o nível está desligado", () => {
    setLogLevel("info");
    let built = 0;
    logger.debug(() => {
      built++;
      return "caro";
    });
    expect(built).toBe(0);

    setLogLevel("debug");
    logger.debug(() => {
      built++;
      return "caro";
    });
    expect(built).toBe(1);
  });

  test("getLogLevel devolve o nível corrente", () => {
    setLogLevel("warn");
    expect(getLogLevel()).toBe("warn");
  });
});
