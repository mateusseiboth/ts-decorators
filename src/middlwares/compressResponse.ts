import { promisify } from "node:util";
import zlib from "node:zlib";

import type { NextFunction, Request, Response } from "express";

const gzip = promisify(zlib.gzip);
const deflate = promisify(zlib.deflate);
const brotli = promisify(zlib.brotliCompress);

/**
 * Qualidade do brotli para RESPOSTA DE API. O padrão do zlib é 11 (a máxima, pensada para
 * asset estático comprimido uma vez): numa listagem de 150 MB ela levou 245 s, enquanto o gzip
 * respondeu em 4 s. Em 4 o brotli ainda comprime mais que o gzip e leva tempo comparável.
 */
const BROTLI_QUALIDADE_DE_API = 4;

export type ResponseEncoding = "br" | "gzip" | "deflate";

/** Strategy map por encoding negociado — sem if/else por tipo. */
const compressors: Record<ResponseEncoding, (buffer: Buffer) => Promise<Buffer>> = {
  br: (buffer) =>
    brotli(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALIDADE_DE_API } }),
  gzip: (buffer) => gzip(buffer),
  deflate: (buffer) => deflate(buffer),
};

/** Ordem de preferência do servidor: br > gzip > deflate (todos aceitos pelos browsers atuais). */
const DEFAULT_PREFERENCE: ResponseEncoding[] = ["br", "gzip", "deflate"];
/** Abaixo disso não compensa comprimir (overhead > ganho). */
const DEFAULT_THRESHOLD = 1024;

/** Só comprimimos conteúdo textual/estruturado — binário (pdf, imagem, zip) já vem comprimido. */
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|javascript|manifest\+json|xml|x-ndjson|ld\+json|graphql)|image\/svg\+xml|.+\+json$|.+\+xml$)/i;
/** Respostas em streaming (SSE) NÃO podem ser bufferadas — quebraria o fluxo incremental. */
const NON_BUFFERABLE = /^text\/event-stream/i;

export interface CompressResponseOptions {
  /** Tamanho mínimo (bytes) do corpo para comprimir. Default 1024. */
  threshold?: number;
  /** Ordem de preferência dos encodings do servidor. Default ["br","gzip","deflate"]. */
  preferredEncodings?: ResponseEncoding[];
  /** Decide se a resposta é comprimível. Default: checa o Content-Type. */
  filter?: (req: Request, res: Response) => boolean;
}

function parseAcceptEncoding(header: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!header) return map;
  for (const part of header.split(",")) {
    const [rawToken, ...params] = part.trim().split(";");
    const token = rawToken?.trim().toLowerCase();
    if (!token) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key?.trim() === "q") q = Number(value);
    }
    map.set(token, Number.isNaN(q) ? 0 : q);
  }
  return map;
}

function negotiate(
  header: string | undefined,
  preference: ResponseEncoding[],
): ResponseEncoding | null {
  const accepted = parseAcceptEncoding(header);
  const wildcard = accepted.get("*");
  for (const encoding of preference) {
    const q = accepted.get(encoding) ?? wildcard;
    if (q !== undefined && q > 0) return encoding;
  }
  return null;
}

function isCompressibleType(_req: Request, res: Response): boolean {
  const contentType = String(res.getHeader("Content-Type") ?? "");
  if (NON_BUFFERABLE.test(contentType)) return false;
  return COMPRESSIBLE.test(contentType);
}

/** Acrescenta `Accept-Encoding` ao Vary sem duplicar — caches precisam variar por encoding. */
function addVary(res: Response, field: string): void {
  const current = res.getHeader("Vary");
  if (current === undefined) return void res.setHeader("Vary", field);
  const values = String(current)
    .split(",")
    .map((value) => value.trim().toLowerCase());
  if (values.includes("*") || values.includes(field.toLowerCase())) return;
  res.setHeader("Vary", `${String(current)}, ${field}`);
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, encoding);
  return Buffer.from(chunk as Uint8Array);
}

/**
 * Middleware de COMPRESSÃO da resposta. Se o cliente enviar `Accept-Encoding` compatível
 * (`br`, `gzip` ou `deflate`) e o corpo for textual/estruturado e acima do threshold, a
 * resposta é comprimida e o `Content-Encoding` correspondente é setado.
 *
 * O corpo comprimível é bufferado e comprimido no `end` (assíncrono, no threadpool do zlib).
 * Respostas não-comprimíveis (arquivos, streams binárias) passam direto, sem buffer — a
 * decisão é tomada na primeira escrita, quando o Content-Type já é conhecido.
 */
export function compressResponse(options: CompressResponseOptions = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const preference = options.preferredEncodings ?? DEFAULT_PREFERENCE;
  const filter = options.filter ?? isCompressibleType;

  return function (req: Request, res: Response, next: NextFunction) {
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    // A resposta varia conforme o Accept-Encoding, comprima-se ou não.
    addVary(res, "Accept-Encoding");

    const chunks: Buffer[] = [];
    let decided = false;
    let buffering = false;
    let encoding: ResponseEncoding | null = null;
    let finalized = false;

    function decide(): void {
      if (decided) return;
      decided = true;
      encoding = eligibleEncoding();
      buffering = encoding !== null;
      // Em modo buffer o tamanho muda; o Content-Length é recalculado/omitido no final.
      if (buffering) res.removeHeader("Content-Length");
    }

    function eligibleEncoding(): ResponseEncoding | null {
      if (req.method === "HEAD") return null;
      if (res.getHeader("Content-Encoding")) return null;
      if (String(res.getHeader("Cache-Control") ?? "").includes("no-transform")) return null;
      const status = res.statusCode;
      if (status < 200 || status === 204 || status === 304) return null;
      if (!filter(req, res)) return null;
      return negotiate(req.headers["accept-encoding"] as string | undefined, preference);
    }

    function finalize(callback?: () => void): void {
      if (finalized) return;
      finalized = true;
      const body = Buffer.concat(chunks);

      // Corpo pequeno demais ou encoding indisponível → envia sem comprimir.
      if (!encoding || body.length < threshold) {
        res.setHeader("Content-Length", String(body.length));
        return void originalEnd(body, callback as () => void);
      }

      compressors[encoding](body)
        .then((compressed) => {
          res.setHeader("Content-Encoding", encoding as ResponseEncoding);
          res.setHeader("Content-Length", String(compressed.length));
          originalEnd(compressed, callback as () => void);
        })
        .catch(() => {
          // Falhou a compressão: manda em claro para não derrubar a resposta.
          res.setHeader("Content-Length", String(body.length));
          originalEnd(body, callback as () => void);
        });
    }

    res.write = function (chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean {
      decide();
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (!buffering || chunk == null) {
        return originalWrite(chunk as never, encodingOrCb as never, cb as never);
      }
      const enc = typeof encodingOrCb === "string" ? (encodingOrCb as BufferEncoding) : undefined;
      chunks.push(toBuffer(chunk, enc));
      if (typeof callback === "function") (callback as () => void)();
      return true;
    } as Response["write"];

    res.end = function (chunk?: unknown, encodingOrCb?: unknown, cb?: unknown): Response {
      decide();
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (!buffering) {
        return originalEnd(
          chunk as never,
          encodingOrCb as never,
          cb as never,
        ) as unknown as Response;
      }
      if (chunk != null && typeof chunk !== "function") {
        const enc = typeof encodingOrCb === "string" ? (encodingOrCb as BufferEncoding) : undefined;
        chunks.push(toBuffer(chunk, enc));
      }
      finalize(callback as (() => void) | undefined);
      return res;
    } as Response["end"];

    next();
  };
}
