/**
 * Peças do `observeHttp` sem OpenTelemetry: caminhos ignorados, rota, id da requisição, headers e
 * corpo prontos para o span.
 */
import type { Request } from "express";

import { REDACTED, isSensitiveKey, redactSensitive } from "./redact";

export const SEM_ROTA = "(sem rota)";
export const BODY_OMITIDO = "[omitido: binário/stream]";
const BODY_NAO_SERIALIZAVEL = "[omitido: não serializável]";

/** Saúde, drenagem e métricas: fora das métricas, do log de acesso e do trace. */
export const CAMINHOS_IGNORADOS: readonly RegExp[] = [
  /^\/health/,
  /^\/internal\/drain/,
  /^\/metrics$/,
];

export function isIgnoredPath(
  path: string,
  caminhos: readonly RegExp[] = CAMINHOS_IGNORADOS,
): boolean {
  return caminhos.some((padrao) => padrao.test(path));
}

/** O caminho sem a query string (o `originalUrl` não muda com o `app.use("/prefixo")`). */
export const readPath = (originalUrl: string): string => originalUrl.split("?", 1)[0] ?? "";

/**
 * A lista que a instrumentation-http consulta (`ignoreIncomingRequestHook`). Ela sobe no preload,
 * antes do `observeHttp` existir: o `observeHttp` registra aqui a lista dele, e a consulta é feita
 * a cada requisição. Com mais de um `observeHttp` no processo, vale a lista do último.
 */
let _caminhosDoTrace: readonly RegExp[] = CAMINHOS_IGNORADOS;

/** Troca a lista dos caminhos fora do trace. Sem argumento, volta à padrão. */
export function setIgnoredPaths(caminhos: readonly RegExp[] = CAMINHOS_IGNORADOS): void {
  _caminhosDoTrace = caminhos;
}

/** O `ignoreIncomingRequestHook`: a URL crua da requisição, com a query. */
export function isIgnoredRequest(req: { url?: string }): boolean {
  if (req.url === undefined) return false;
  return isIgnoredPath(readPath(req.url), _caminhosDoTrace);
}

/** O Express aceita texto, expressão regular ou lista delas como caminho da rota. */
const formatRoutePath = (path: unknown): string => {
  if (typeof path === "string") return path;
  if (Array.isArray(path)) return path.map(formatRoutePath).join(",");
  return (path as RegExp).toString();
};

/** Template da rota do Express (`/api/v1/imoveis/:id`). Sem rota casada, `(sem rota)`. */
export function readRoute(req: Pick<Request, "baseUrl" | "route">): string {
  const path: unknown = req.route?.path;
  if (path === undefined || path === null) return SEM_ROTA;
  const baseUrl = req.baseUrl ?? "";
  // `router.get("/")` montado em `/api/imoveis`: a rota é `/api/imoveis`, sem a barra no fim.
  if (path === "/" && baseUrl !== "") return baseUrl;
  return `${baseUrl}${formatRoutePath(path)}`;
}

// ── Id da requisição ──────────────────────────────────────────────────────────────────────────

const REQUEST_ID_SEGURO = /^[\x21-\x7e]{1,128}$/;

type HeadersDaRequisicao = Record<string, string | string[] | undefined>;

/** O `x-request-id` que chegou (do gateway), quando é texto imprimível curto; senão, um uuid v7. */
export function readRequestId(headers: HeadersDaRequisicao): string {
  const recebido = headers["x-request-id"];
  const texto = Array.isArray(recebido) ? recebido[0] : recebido;
  return texto && REQUEST_ID_SEGURO.test(texto) ? texto : Bun.randomUUIDv7();
}

// ── Headers ───────────────────────────────────────────────────────────────────────────────────

type ValorDeHeader = string | number | readonly string[] | undefined;

const formatHeaderValue = (valor: ValorDeHeader): string =>
  Array.isArray(valor) ? valor.join(", ") : String(valor);

/** Um atributo por header (`<prefixo>.<nome>`), com os sensíveis mascarados. */
export function buildHeaderAttributes(
  prefixo: string,
  headers: Record<string, ValorDeHeader>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, valor]) => valor !== undefined)
      .map(([nome, valor]) => [
        `${prefixo}.${nome.toLowerCase()}`,
        isSensitiveKey(nome) ? REDACTED : formatHeaderValue(valor),
      ]),
  );
}

// ── Corpo ─────────────────────────────────────────────────────────────────────────────────────

const TIPOS_BINARIOS: readonly RegExp[] = [
  /^application\/octet-stream/,
  /^application\/pdf/,
  /^application\/zip/,
  /^image\//,
  /^video\//,
  /^audio\//,
];

const isBinaryContentType = (tipo: string | undefined): boolean =>
  tipo !== undefined && TIPOS_BINARIOS.some((padrao) => padrao.test(tipo));

/** Stream do Node é qualquer objeto com `pipe`: não há classe base para `instanceof`. */
const isBinaryOrStream = (corpo: unknown): boolean =>
  corpo instanceof Uint8Array ||
  corpo instanceof ArrayBuffer ||
  typeof (corpo as { pipe?: unknown } | null)?.pipe === "function";

const parseJsonText = (texto: string, tipo: string | undefined): unknown => {
  if (!tipo?.includes("json")) return texto;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
};

const stringifyBody = (corpo: unknown, tipo: string | undefined): string => {
  const valor = typeof corpo === "string" ? parseJsonText(corpo, tipo) : corpo;
  if (typeof valor === "string") return valor;
  return JSON.stringify(redactSensitive(valor), (_chave, aninhado) =>
    typeof aninhado === "bigint" ? aninhado.toString() : aninhado,
  );
};

/** Corta em `maxBytes` sem partir um caractere UTF-8 e diz o tamanho original. */
export function truncateUtf8(texto: string, maxBytes: number): string {
  const total = Buffer.byteLength(texto, "utf8");
  if (total <= maxBytes) return texto;
  const corte = Buffer.from(texto, "utf8").subarray(0, maxBytes).toString("utf8");
  // O último caractere partido vira U+FFFD na decodificação: sai.
  return `${corte.replace(/�$/, "")}… [truncado: ${total} bytes]`;
}

/**
 * O corpo pronto para o atributo do span: JSON com credenciais mascaradas, inteiro até `maxBytes`.
 * Binário e stream não entram (`[omitido: binário/stream]`).
 */
export function serializeBody(corpo: unknown, tipo: string | undefined, maxBytes: number): string {
  if (corpo === undefined || corpo === null) return "";
  if (isBinaryContentType(tipo) || isBinaryOrStream(corpo)) return BODY_OMITIDO;
  try {
    return truncateUtf8(stringifyBody(corpo, tipo) ?? "", maxBytes);
  } catch {
    return BODY_NAO_SERIALIZAVEL;
  }
}
