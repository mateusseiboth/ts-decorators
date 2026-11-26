/**
 * @Deprecated e deprecatedMiddleware: marca rota obsoleta com os cabeçalhos `Deprecation`
 * (RFC 9745), `Sunset` (RFC 8594) e `Link rel="deprecation"`, e avisa no log uma vez por rota.
 *
 * Uso:
 *   @Deprecated({ sunset: "2027-01-01", link: "https://docs/v2", message: "use GET /v2/imoveis" })
 *   async list(req, res) { ... }
 *
 *   router.use(deprecatedMiddleware({ sunset: "2027-01-01" }));
 */
import type { Request, RequestHandler, Response } from "express";

import { logger } from "../functions/logger";
import { makeMethodDecorator } from "./_method";

export interface DeprecatedOptions {
  /** Desde quando está obsoleta. */
  since?: string | Date;
  /** Quando deixa de existir. */
  sunset?: string | Date;
  /** Página que explica a troca. */
  link?: string;
  /** O que usar no lugar, para o log. */
  message?: string;
  /** Depois do `sunset`, responde 410 em vez de executar. Default: false. */
  blockAfterSunset?: boolean;
}

// Texto para o usuário final: o que aconteceu e o que fazer, sem detalhe de API.
const MENSAGEM_DE_DESCONTINUADA =
  "Esta funcionalidade não está mais disponível. Atualize o sistema ou procure o suporte.";

/** Só o que o decorator usa da Response: o mock do teste e a do Express servem. */
type ResponseMarcavel = Pick<Response, "setHeader" | "status"> & {
  getHeader?: Response["getHeader"];
};

interface Deprecacao {
  applyCabecalhos(res: ResponseMarcavel): void;
  isBloqueada(): boolean;
  /** Avisa no log na primeira vez que a rota (ou o método) aparece. */
  warnUmaVez(rota: string): void;
}

const parseData = (
  campo: "since" | "sunset",
  valor: string | Date | undefined,
): Date | undefined => {
  if (valor === undefined) return undefined;
  const data = valor instanceof Date ? valor : new Date(valor);
  if (!Number.isNaN(data.getTime())) return data;
  throw new Error(
    `[@mateusseiboth/ts-decorators] @Deprecated: '${campo}' não é uma data válida (${String(valor)}). ` +
      "Use uma data ISO, como 2027-01-01, ou um Date.",
  );
};

const buildDeprecation = (since: Date | undefined): string =>
  since ? `@${Math.floor(since.getTime() / 1000)}` : "true";

const buildLink = (link: string) => `<${link}>; rel="deprecation"; type="text/html"`;

/** O `Link` que a resposta já tem, mais o da obsolescência. */
const appendLink = (existente: ReturnType<Response["getHeader"]>, novo: string): string =>
  [existente ?? []].flat().concat(novo).join(", ");

const buildCabecalhos = (
  options: DeprecatedOptions,
  sunset: Date | undefined,
): Array<[string, string]> => {
  const cabecalhos: Array<[string, string]> = [
    ["Deprecation", buildDeprecation(parseData("since", options.since))],
  ];
  if (sunset) cabecalhos.push(["Sunset", sunset.toUTCString()]);
  return cabecalhos;
};

const buildAviso = (rota: string, message: string | undefined): string =>
  `[@mateusseiboth/ts-decorators] @Deprecated: ${rota} está obsoleta.` +
  (message ? ` ${message}` : "");

const createDeprecacao = (options: DeprecatedOptions = {}): Deprecacao => {
  const sunset = parseData("sunset", options.sunset);
  const cabecalhos = buildCabecalhos(options, sunset);
  const avisadas = new Set<string>();

  return {
    applyCabecalhos(res) {
      for (const [nome, valor] of cabecalhos) res.setHeader(nome, valor);
      if (!options.link) return;
      res.setHeader("Link", appendLink(res.getHeader?.("Link"), buildLink(options.link)));
    },
    isBloqueada: () => Boolean(options.blockAfterSunset && sunset && Date.now() > sunset.getTime()),
    warnUmaVez(rota) {
      if (avisadas.has(rota)) return;
      avisadas.add(rota);
      logger.warn(buildAviso(rota, options.message));
    },
  };
};

const isResponse = (valor: unknown): valor is ResponseMarcavel =>
  typeof (valor as ResponseMarcavel | undefined)?.setHeader === "function" &&
  typeof (valor as ResponseMarcavel | undefined)?.status === "function";

const respondDescontinuada = (res: ResponseMarcavel): void => {
  res.status(410).json({ message: MENSAGEM_DE_DESCONTINUADA });
};

/**
 * Marca a resposta e diz se a rota segue. `false` quando já respondeu 410.
 */
const applyDeprecacao = (deprecacao: Deprecacao, res: ResponseMarcavel): boolean => {
  deprecacao.applyCabecalhos(res);
  if (!deprecacao.isBloqueada()) return true;
  respondDescontinuada(res);
  return false;
};

export function Deprecated(options?: DeprecatedOptions): (...args: any[]) => any {
  const deprecacao = createDeprecacao(options);
  return makeMethodDecorator("Deprecated", (original, methodName) => {
    return function (this: any, ...args: any[]) {
      deprecacao.warnUmaVez(`${this?.constructor?.name ?? "fn"}.${methodName}`);
      const res = args.find(isResponse);
      if (res && !applyDeprecacao(deprecacao, res)) return undefined;
      return original.apply(this, args);
    };
  });
}

/** A rota como foi declarada (`/v1/imoveis/:id`), não a URL chamada: o conjunto não cresce. */
const buildRota = (req: Request): string =>
  `${req.method} ${req.baseUrl ?? ""}${req.route?.path ?? ""}`;

export function deprecatedMiddleware(options?: DeprecatedOptions): RequestHandler {
  const deprecacao = createDeprecacao(options);
  return (req, res, next) => {
    deprecacao.warnUmaVez(buildRota(req));
    if (applyDeprecacao(deprecacao, res)) next();
  };
}
