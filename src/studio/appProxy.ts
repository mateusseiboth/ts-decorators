/**
 * Meio-campo entre o Studio e as rotas do `createReportRouter` do app (evita CORS no navegador).
 * A tela informa uma conexão (endereço base do router, relatório e headers) e uma ação; cada ação
 * é uma entrada do mapa, que diz o método, o caminho e o corpo.
 */
export interface StudioConnection {
  /** Endereço onde o app montou o `createReportRouter` (ex.: http://host/relatorio/api). */
  baseUrl: string;
  reportId: string;
  headers?: Record<string, unknown>;
}

interface AppRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
}

type AppAction = (reportId: string, body: Record<string, unknown>) => AppRequest;

const APP_ACTIONS: Record<string, AppAction> = {
  data: (id, body) => ({ method: "POST", path: `data/${id}`, body: body.filters ?? {} }),
  templates: (id) => ({ method: "GET", path: `templates/${id}` }),
  "save-template": (id, body) => ({
    method: "POST",
    path: `templates/${id}`,
    body: { name: body.name, content: body.content },
  }),
  "activate-template": (id, body) =>
    typeof body.templateId === "string" && body.templateId
      ? { method: "PUT", path: `templates/${id}/active/${encodeURIComponent(body.templateId)}` }
      : { method: "DELETE", path: `templates/${id}/active` },
};

const json = (status: number, body: unknown) => Response.json(body, { status });

function onlyFilledHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
    ),
  );
}

function parseConnection(raw: unknown): StudioConnection | null {
  const connection = (raw ?? {}) as Partial<StudioConnection>;
  const baseUrl = String(connection.baseUrl ?? "").trim();
  const reportId = String(connection.reportId ?? "").trim();
  if (!baseUrl || !reportId) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), reportId, headers: connection.headers };
}

async function forward(connection: StudioConnection, request: AppRequest): Promise<Response> {
  const hasBody = request.body !== undefined;
  const response = await fetch(`${connection.baseUrl}/${request.path}`, {
    method: request.method,
    headers: {
      ...(hasBody && { "content-type": "application/json" }),
      ...onlyFilledHeaders(connection.headers),
    },
    body: hasBody ? JSON.stringify(request.body) : undefined,
    // Seguir o redirecionamento furaria a lista de sistemas permitidos.
    redirect: "manual",
  });
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Hospedado, o Studio é um proxy dentro da rede interna: com a lista definida, ele só conversa
 * com os sistemas dela. Vazia ou ausente, aceita qualquer endereço (uso local).
 */
export function isOriginAllowed(baseUrl: string, allowedOrigins: readonly string[]): boolean {
  if (!allowedOrigins.length) return true;
  const origin = originOf(baseUrl);
  return origin !== null && allowedOrigins.some((allowed) => originOf(allowed) === origin);
}

export async function runAppAction(
  action: string,
  body: Record<string, unknown>,
  allowedOrigins: readonly string[] = [],
) {
  const build = APP_ACTIONS[action];
  if (!build) return json(404, { message: `Ação desconhecida: ${action}.` });
  const connection = parseConnection(body.connection);
  if (!connection) return json(400, { message: "Informe o endereço do sistema e o relatório." });
  if (!isOriginAllowed(connection.baseUrl, allowedOrigins)) {
    const origin = originOf(connection.baseUrl) ?? connection.baseUrl;
    return json(403, {
      message: `Este Studio não acessa ${origin}. Peça para incluir o sistema na lista ou use o Studio local.`,
    });
  }
  try {
    return await forward(connection, build(encodeURIComponent(connection.reportId), body));
  } catch (error) {
    const detalhe = error instanceof Error ? error.message : String(error);
    return json(502, { message: `Não foi possível falar com o sistema. ${detalhe}` });
  }
}
