/**
 * Facade ÚNICA de decisão: grant (RBAC, do token) + condições (ABAC, avaliadas em runtime). O
 * decorator, os services e o middleware de rota de cada app consomem daqui: a regra vive só aqui.
 *
 * Tag NEGATIVA não é considerada: é passe livre para qualquer usuário autenticado (sujeito
 * resolvido). Não há opção para mudar.
 *
 * Cada recusa do `authorize` e do `decideRouteAccess` conta em `app.permission.denied`, com a tag
 * no rótulo `permissao`. Tag inválida (erro de configuração, 500) e a pergunta do `isAllowed` não
 * contam.
 */
import { METRICA } from "../observability/catalog";
import { incrementMetric } from "../observability/metrics";
import { getActionDef } from "./catalog";
import { requirePermissionsConfig, type ResolvedPermissionsConfig } from "./config";
import { evaluateConditions } from "./policy";
import type {
  ActionKey,
  AuthorizeDecision,
  AuthorizeInput,
  AuthorizeOptions,
  PermissionSubject,
  PolicyContext,
  RouteAccessDenial,
  RouteAccessInput,
} from "./types";

const ALLOWED: AuthorizeDecision = Object.freeze({ allowed: true });

const isLivre = (tag: number): boolean => tag < 0;

export function isAuthorized(input: AuthorizeInput): AuthorizeDecision {
  const { messages } = requirePermissionsConfig();
  if (isLivre(input.tag) || input.bypass) return ALLOWED;

  const granted = input.roles?.[input.tag]?.[input.action] === true;
  if (!granted) return { allowed: false, reason: messages.denied };

  const definition = getActionDef(input.tag, input.action);
  const ctx: PolicyContext = { ...input.ctx, resource: input.resource ?? input.ctx.resource };
  if (!evaluateConditions(definition?.conditions, ctx)) {
    return { allowed: false, reason: messages.denied };
  }

  return ALLOWED;
}

/** `"1:trocar-avatar"` → `{ tag: 1, action: "trocar-avatar" }`. */
export function parseKey(key: string): { tag: number; action: ActionKey } {
  const [tag, action] = key.split(":");
  return { tag: Number(tag), action: action ?? "" };
}

const attributesOf = (subject: PermissionSubject): PolicyContext => subject.attributes ?? {};

/**
 * A decisão de quem tem contexto e sujeito: passe livre, tenant, tag negativa, matriz. É a mesma
 * para a rota e para o `isAllowed`; `null` libera.
 */
function decideSubject(
  config: ResolvedPermissionsConfig,
  input: RouteAccessInput,
): RouteAccessDenial | null {
  const { messages } = config;
  if (!Number.isInteger(input.tag)) return { status: 500, message: messages.invalidTag };

  const subject = config.resolveSubject(input.context, input.tag);
  if (!subject) return { status: 401, message: messages.unauthenticated };
  if (subject.bypass) return null;
  if (config.isSameEntity?.(input.context) === false) {
    return { status: 403, message: messages.entityDenied };
  }

  const decision = isAuthorized({
    tag: input.tag,
    action: input.action,
    roles: subject.roles,
    ctx: attributesOf(subject),
  });
  if (decision.allowed) return null;

  return {
    status: 403,
    message: messages.actionDenied[input.action] ?? decision.reason ?? messages.denied,
  };
}

const countNegada = (tag: number): void =>
  incrementMetric({ ...METRICA.PERMISSION_DENIED, attributes: { permissao: String(tag) } });

/** Status de configuração errada: não é recusa de permissão. */
const STATUS_DE_CONFIGURACAO = 500;

/**
 * A decisão do middleware de rota de cada app, sem `req` nem `res`: `null` libera, o objeto diz o
 * status e a mensagem da recusa. Condição que depende da INSTÂNCIA do recurso não entra aqui (o
 * recurso ainda não foi carregado); ela roda no service, pelo `@RequiresPermission`.
 */
export function decideRouteAccess<Ctx>(input: RouteAccessInput<Ctx>): RouteAccessDenial | null {
  const recusa = decideSubject(requirePermissionsConfig(), input);
  if (recusa && recusa.status !== STATUS_DE_CONFIGURACAO) countNegada(input.tag);
  return recusa;
}

/**
 * A PERGUNTA da mesma decisão: "o usuário do contexto pode `tag:action`?", sem lançar. Serve a quem
 * precisa ESCONDER o que o usuário não pode abrir (a busca global). Condição que depende da
 * instância do recurso não entra, porque nesta altura não há recurso carregado.
 */
export function isAllowed(key: string): boolean {
  const config = requirePermissionsConfig();
  const context = config.getContext();
  if (!context) return config.isAllowedOutsideRequest;

  return decideSubject(config, { context, ...parseKey(key) }) === null;
}

/** Conta a recusa e lança o erro de negação do app. */
const deny = (config: ResolvedPermissionsConfig, tag: number, message: string): never => {
  countNegada(tag);
  throw config.createForbiddenError(message);
};

const OUTSIDE_REQUEST: Record<
  ResolvedPermissionsConfig["authorizeOutsideRequest"],
  (config: ResolvedPermissionsConfig, tag: number) => void
> = {
  allow: () => undefined,
  deny: (config, tag) => deny(config, tag, config.messages.denied),
};

/**
 * Autorização com o contexto da requisição. Lança o erro de negação do app (padrão
 * `PermissionDeniedError`, 403).
 *
 * Ordem: (1) grant RBAC + condições ABAC do catálogo, que respeitam o passe livre do sujeito e o
 * `bypass` da opção; (2) `check` custom, que SEMPRE roda, porque é regra de negócio, não matriz.
 */
export async function authorize(key: string, options: AuthorizeOptions = {}): Promise<void> {
  const config = requirePermissionsConfig();
  const { tag, action } = parseKey(key);
  const context = config.getContext();
  if (!context) return OUTSIDE_REQUEST[config.authorizeOutsideRequest](config, tag);

  const subject = config.resolveSubject(context, tag);
  if (!subject) return deny(config, tag, config.messages.unauthenticated);

  const attributes = attributesOf(subject);
  const decision = isAuthorized({
    tag,
    action,
    roles: subject.roles,
    ctx: attributes,
    resource: options.resource,
    bypass: subject.bypass || options.bypass === true,
  });
  if (!decision.allowed) return deny(config, tag, decision.reason ?? config.messages.denied);

  if (!options.check) return;
  const approved = await options.check({
    ...attributes,
    args: options.args ?? [],
    resource: options.resource,
  });
  if (!approved) deny(config, tag, config.messages.denied);
}
