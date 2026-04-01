/**
 * Helpers compartilhados para testes.
 */
import type {NextFunction, Request} from "express";

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
    socket: {remoteAddress: "127.0.0.1"},
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
export function mockNext(): NextFunction & {called: boolean; error?: any} {
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
    access: {has: () => true, get: () => undefined},
  } as any;
}

/** Cria um DecoratorContext fake para TC39 Stage 3 field decorators */
export function fakeFieldContext(name: string, metadata: Record<string, any> = {}): ClassFieldDecoratorContext {
  return {
    kind: "field",
    name,
    static: false,
    private: false,
    metadata,
    addInitializer(_fn: () => void) {},
    access: {has: () => true, get: () => undefined, set: () => {}},
  } as any;
}

/** Captura console.warn calls */
export function captureWarnings(): {warnings: string[]; restore: () => void} {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => {
    warnings.push(args.join(" "));
  };
  return {
    warnings,
    restore: () => {
      console.warn = origWarn;
    },
  };
}

/** Captura console.log calls */
export function captureLogs(): {logs: string[]; restore: () => void} {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  return {
    logs,
    restore: () => {
      console.log = origLog;
    },
  };
}
