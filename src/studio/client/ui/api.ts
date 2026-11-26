/** Chamadas do cliente ao servidor local do Studio. */
import type { HelperDocLike } from "../logic/completion";

export interface Problem {
  severity: "error" | "warning";
  message: string;
  line: number;
  column: number;
}

export interface Starter {
  id: string;
  name: string;
  description: string;
  template: string;
  sampleData: Record<string, unknown>;
}

export interface Connection {
  baseUrl: string;
  reportId: string;
  headers: Record<string, string>;
}

export interface SystemTemplate {
  id: string;
  name: string;
  content: string;
  active: boolean;
  createdAt?: number;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  body: T & { message?: string };
}

async function readJsonBody<T>(response: Response): Promise<ApiResult<T>> {
  const body = (await response.json().catch(() => ({}))) as T & { message?: string };
  return { ok: response.ok, status: response.status, body };
}

export async function postJson<T>(path: string, payload: unknown): Promise<ApiResult<T>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readJsonBody<T>(response);
}

export const fetchHelpers = async () =>
  (await (await fetch("/api/helpers")).json()) as HelperDocLike[];

export const fetchStarters = async () => (await (await fetch("/api/starters")).json()) as Starter[];

export interface RenderPayload {
  template: string;
  data: unknown;
}

export const renderPreview = (payload: RenderPayload) =>
  postJson<{ html: string; ms: number; line?: number }>("/api/render", payload);

export const lintPreview = (payload: RenderPayload) =>
  postJson<{ problems: Problem[] }>("/api/lint", payload);

export interface PdfPayload extends RenderPayload {
  pageFormat: string;
  landscape: boolean;
}

export async function requestPdf(payload: PdfPayload): Promise<Blob | { message: string }> {
  const response = await fetch("/api/pdf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.ok) return response.blob();
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  return { message: body.message ?? `Erro ${response.status} ao gerar o PDF.` };
}

export const appAction = <T>(action: string, connection: Connection, extra: object = {}) =>
  postJson<T>(`/api/app/${action}`, { connection, ...extra });

export const describeFailure = (result: ApiResult<unknown>, fallback: string) =>
  result.body.message ?? `${fallback} (erro ${result.status}).`;
