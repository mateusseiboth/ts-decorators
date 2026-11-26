/**
 * Helpers compartilhados para testes.
 */
import type { NextFunction, Request } from "express";

import { setLogWriter } from "../src/functions/logger";

/** Cria um mock de Request do Express */
export function mockReq(overrides: Partial<Request> & Record<string, any> = {}): any {
  return {
    method: "GET",
    query: {},
    params: {},
    headers: {},
    ip: "127.0.0.1",
    originalUrl: "/test",
    url: "/test",
    baseUrl: "",
    path: "/test",
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
  };
}

/** Cria um mock de Response do Express */
export function mockRes(overrides: Record<string, any> = {}): any {
  const res: any = {
    statusCode: 200,
    headersSent: false,
    locals: {},
    _headers: {} as Record<string, any>,
    _body: undefined as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
    setHeader(key: string, value: any) {
      res._headers[key] = value;
      return res;
    },
    removeListener() {
      return res;
    },
    on() {
      return res;
    },
    ...overrides,
  };
  return res;
}

/** Cria um mock de NextFunction do Express */
export function mockNext(): NextFunction & { called: boolean; error?: any } {
  const fn: any = (err?: any) => {
    fn.called = true;
    fn.error = err;
  };
  fn.called = false;
  fn.error = undefined;
  return fn;
}

/** Cria um DecoratorContext fake para TC39 Stage 3 class decorators */
export function fakeClassContext(name: string): ClassDecoratorContext {
  return {
    kind: "class",
    name,
    metadata: {},
    addInitializer(_fn: () => void) {},
  } as any;
}

/** Cria um DecoratorContext fake para TC39 Stage 3 method decorators */
export function fakeMethodContext(name: string): ClassMethodDecoratorContext {
  return {
    kind: "method",
    name,
    static: false,
    private: false,
    metadata: {},
    addInitializer(_fn: () => void) {},
    access: { has: () => true, get: () => undefined },
  } as any;
}

/** Cria um DecoratorContext fake para TC39 Stage 3 field decorators */
export function fakeFieldContext(
  name: string,
  metadata: Record<string, any> = {},
): ClassFieldDecoratorContext {
  return {
    kind: "field",
    name,
    static: false,
    private: false,
    metadata,
    addInitializer(_fn: () => void) {},
    access: { has: () => true, get: () => undefined, set: () => {} },
  } as any;
}

type NivelCapturado = "debug" | "info" | "warn" | "error";
type Captura = { niveis: readonly NivelCapturado[]; linhas: string[] };

/**
 * O logger escreve direto no stdout (não passa pelo `console`). As capturas abertas dividem um
 * escritor só, que entrega cada linha às capturas do nível dela; a última a fechar devolve o stdout.
 */
const _capturas = new Set<Captura>();

const tapLogger = (captura: Captura): (() => void) => {
  _capturas.add(captura);
  setLogWriter((linha, nivel) => {
    for (const aberta of _capturas) if (aberta.niveis.includes(nivel)) aberta.linhas.push(linha);
  });
  return () => {
    _capturas.delete(captura);
    if (_capturas.size === 0) setLogWriter();
  };
};

type MetodoDoConsole = "log" | "warn" | "error";

/** Captura o logger nesses níveis e o `console[metodo]` direto. */
function captureOutput(
  metodo: MetodoDoConsole,
  niveis: readonly NivelCapturado[],
): { linhas: string[]; restore: () => void } {
  const linhas: string[] = [];
  const original = console[metodo];
  console[metodo] = (...args: any[]) => {
    linhas.push(args.join(" "));
  };
  const untap = tapLogger({ niveis, linhas });
  return {
    linhas,
    restore: () => {
      console[metodo] = original;
      untap();
    },
  };
}

/** Captura `logger.warn` e `console.warn`. */
export function captureWarnings(): { warnings: string[]; restore: () => void } {
  const { linhas, restore } = captureOutput("warn", ["warn"]);
  return { warnings: linhas, restore };
}

/** Captura `logger.info`, `logger.debug` e `console.log`. */
export function captureLogs(): { logs: string[]; restore: () => void } {
  const { linhas, restore } = captureOutput("log", ["info", "debug"]);
  return { logs: linhas, restore };
}

/** Captura `logger.error` e `console.error`. */
export function captureErrors(): { errors: string[]; restore: () => void } {
  const { linhas, restore } = captureOutput("error", ["error"]);
  return { errors: linhas, restore };
}
