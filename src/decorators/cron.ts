/**
 * @Cron(expr | intervalMs) — agenda a execução periódica de um método.
 *
 * Aceita:
 *  - número: intervalo em milissegundos.
 *  - string cron de 5 campos: "min hora diaMes mes diaSemana" (suporta `*`,
 *    listas `1,2`, passos `*\/5` e ranges `1-5`).
 *
 * A assinatura só agenda quando há instância:
 *  - TC39: automático via `context.addInitializer`.
 *  - Legacy: chame `startCronJobs(instance)` após criar a instância (ou resolva
 *    via `container.get`, que já cuida disso).
 *
 * Uso:
 *   @Cron("*\/5 * * * *")   // a cada 5 minutos
 *   async limparExpirados() { ... }
 */

import "reflect-metadata";
import {isDecoratorContext, warnLegacy} from "./_proxy";

const CRON_KEY = "cron:jobs";
const _started = new WeakSet<object>();
const _timers = new Set<ReturnType<typeof setInterval>>();

interface CronMeta {
  expr: string | number;
  methodName: string;
}

function matchField(field: string, value: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((part) => {
    if (part.includes("/")) {
      const [range, stepRaw] = part.split("/");
      const step = Number(stepRaw);
      const [start, end] = range === "*" ? [0, Infinity] : range!.split("-").map(Number);
      return value >= (start ?? 0) && value <= (end ?? Infinity) && (value - (start ?? 0)) % step === 0;
    }
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      return value >= (start ?? 0) && value <= (end ?? 0);
    }
    return Number(part) === value;
  });
}

/** Verdadeiro se a expressão cron de 5 campos casa com a data informada. */
export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Expressão cron inválida: "${expr}"`);
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  return (
    matchField(min, date.getMinutes()) &&
    matchField(hour, date.getHours()) &&
    matchField(dom, date.getDate()) &&
    matchField(mon, date.getMonth() + 1) &&
    matchField(dow, date.getDay())
  );
}

function schedule(instance: any, meta: CronMeta): void {
  const run = () => Promise.resolve(instance[meta.methodName]()).catch((err) => {
    console.error(`[Cron] erro em ${instance.constructor?.name}.${meta.methodName}:`, err);
  });

  if (typeof meta.expr === "number") {
    const timer = setInterval(run, meta.expr);
    if ((timer as any).unref) (timer as any).unref();
    _timers.add(timer);
    return;
  }

  // Cron string: verifica a cada minuto se casa com o instante atual.
  let lastMinute = -1;
  const timer = setInterval(() => {
    const now = new Date();
    if (now.getMinutes() === lastMinute) return;
    lastMinute = now.getMinutes();
    if (cronMatches(meta.expr as string, now)) run();
  }, 30_000);
  if ((timer as any).unref) (timer as any).unref();
  _timers.add(timer);
}

/** Inicia os jobs @Cron declarados na instância (idempotente por instância). */
export function startCronJobs(instance: any): void {
  if (!instance || _started.has(instance)) return;
  const list: CronMeta[] = Reflect.getMetadata(CRON_KEY, instance.constructor) ?? [];
  for (const meta of list) schedule(instance, meta);
  _started.add(instance);
}

/** Para todos os cron jobs (útil em testes/shutdown). */
export function stopAllCronJobs(): void {
  for (const timer of _timers) clearInterval(timer);
  _timers.clear();
}

export function Cron(expr: string | number) {
  return function (...args: any[]): any {
    // TC39 Stage 3: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const original = args[0] as Function;
      const context = args[1] as ClassMethodDecoratorContext;
      const methodName = String(context.name);
      context.addInitializer(function (this: any) {
        schedule(this, {expr, methodName});
      });
      return original;
    }

    // Legacy: (target, propertyKey, descriptor)
    warnLegacy("Cron");
    const target = args[0];
    const propertyKey = args[1] as string;
    const list: CronMeta[] = Reflect.getMetadata(CRON_KEY, target.constructor) ?? [];
    list.push({expr, methodName: propertyKey});
    Reflect.defineMetadata(CRON_KEY, list, target.constructor);
    return args[2];
  };
}
