import {afterEach, describe, expect, test} from "bun:test";
import {Cron, cronMatches, startCronJobs, stopAllCronJobs} from "../src/decorators/cron";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cronMatches", () => {
  test("'*' casa com qualquer minuto", () => {
    expect(cronMatches("* * * * *", new Date(2026, 0, 1, 10, 30))).toBe(true);
  });

  test("minuto específico", () => {
    const d = new Date(2026, 0, 1, 10, 30);
    expect(cronMatches("30 * * * *", d)).toBe(true);
    expect(cronMatches("31 * * * *", d)).toBe(false);
  });

  test("passo */5", () => {
    expect(cronMatches("*/5 * * * *", new Date(2026, 0, 1, 10, 15))).toBe(true);
    expect(cronMatches("*/5 * * * *", new Date(2026, 0, 1, 10, 16))).toBe(false);
  });

  test("range e lista", () => {
    const d = new Date(2026, 0, 1, 10, 0); // 10h
    expect(cronMatches("0 8-12 * * *", d)).toBe(true);
    expect(cronMatches("0 1,2,10 * * *", d)).toBe(true);
    expect(cronMatches("0 1,2,3 * * *", d)).toBe(false);
  });

  test("expressão inválida lança", () => {
    expect(() => cronMatches("* * *", new Date())).toThrow();
  });
});

describe("@Cron (intervalo numérico)", () => {
  afterEach(() => stopAllCronJobs());

  test("executa periodicamente por intervalo (legacy via startCronJobs)", async () => {
    let count = 0;
    class Jobs {
      @Cron(20)
      tick() {
        count++;
      }
    }
    startCronJobs(new Jobs());
    await delay(70);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
