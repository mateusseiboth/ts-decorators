/**
 * Tipos do modelo de permissões RBAC + ABAC.
 *
 * Ponto de verdade do catálogo: a descoberta dos Models (`getAllModels`) somada à AGREGAÇÃO do app
 * (`PermissionsConfig.catalog`), que só acrescenta ações e condições às tags existentes e declara as
 * tags CUSTOMIZADAS (recursos sem Model).
 */

/** Chave livre de ação: `"list"`, `"create"`, `"aprovar"`, `"enviar-boas-vindas"`. */
export type ActionKey = string;

export interface ConditionOperators {
  eq?: unknown;
  ne?: unknown;
  in?: unknown[];
  gt?: number;
  lt?: number;
  /** `true` exige que o atributo (dono do recurso) seja o usuário autenticado (`user.id`). */
  ownerId?: boolean;
}

/** `{ "resource.status": { eq: "ABERTO" } }`: AND de caminhos, AND de operadores. */
export type Conditions = Record<string, ConditionOperators>;

export interface PermissionActionDef {
  label: string;
  conditions?: Conditions;
}

export interface ResourceAugmentation {
  /** Obrigatório só em tag CUSTOM: o recurso com Model herda o `nome` do Model. */
  label?: string;
  actions?: Record<ActionKey, PermissionActionDef>;
}

/** O catálogo do app: `tag → ações e condições a mais`. */
export type CatalogAugmentation = Record<number, ResourceAugmentation>;

export interface CatalogAction {
  action: ActionKey;
  label: string;
  hasConditions: boolean;
  conditions?: Conditions;
}

export interface CatalogResource {
  tag: number;
  label: string;
  custom: boolean;
  actions: CatalogAction[];
}

/** Permissões efetivas do usuário, como vêm no token: `tag → ação → concedida`. */
export type Roles = Record<number, Record<ActionKey, boolean>>;

/**
 * Atributos que o motor ABAC enxerga ao resolver os caminhos das condições. Cada chave é uma raiz
 * de caminho (`user.id`, `resource.status`, `entity`); o app pode publicar outras (`almoxarifadoId`).
 */
export interface PolicyContext {
  user?: Record<string, unknown>;
  /** Tenant corrente (tenant). */
  entity?: string | number;
  resource?: Record<string, unknown>;
  env?: Record<string, unknown>;
  [root: string]: unknown;
}

export interface AuthorizeInput {
  tag: number;
  action: ActionKey;
  roles?: Roles;
  ctx: PolicyContext;
  resource?: Record<string, unknown>;
  bypass?: boolean;
}

export interface AuthorizeDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * O que a checagem custom (`check`) recebe: os argumentos do método, o recurso e os atributos do
 * sujeito (`user`, `entity` e o que o app publicar). Roda dentro do contexto da requisição.
 */
export type PermissionCheckContext = PolicyContext & { args: unknown[] };

/** Regra de negócio custom (exercício aberto, conta ativa). Pode ser async e consultar o banco. */
export type PermissionCheck = (context: PermissionCheckContext) => boolean | Promise<boolean>;

/** Quem pede: as permissões, o passe livre e os atributos que as condições enxergam. */
export interface PermissionSubject {
  roles: Roles;
  /** Passe livre (administrador, suporte): ignora a matriz. O `check` continua rodando. */
  bypass: boolean;
  /** Raízes do contexto de política (`user`, `entity`, `env`). Chegam também ao `check`. */
  attributes?: PolicyContext;
}

export interface PermissionMessages {
  /** Negação genérica: sem grant, condição reprovada ou `check` que devolveu `false`. */
  denied: string;
  /** Token de um tenant usado em outra. */
  entityDenied: string;
  /** Sujeito não resolvido (`resolveSubject` devolveu `undefined`). */
  unauthenticated: string;
  /** Model sem tag inteira na decisão de rota. */
  invalidTag: string;
  /** Negação da rota, por ação. Ação fora do mapa usa `denied`. */
  actionDenied: Record<ActionKey, string>;
}

/** As mensagens que o app troca; `actionDenied` se soma ao padrão, ação por ação. */
export type PermissionMessagesInput = Partial<Omit<PermissionMessages, "actionDenied">> & {
  actionDenied?: Record<ActionKey, string>;
};

/** O que fazer com o `authorize` chamado fora de uma requisição (job, script). */
export type OutsideRequestPolicy = "allow" | "deny";

export interface PermissionsConfig<Ctx = unknown, Extra extends object = Record<never, never>> {
  /** As ações e condições a mais por tag e as tags custom (a partir de `CUSTOM_TAG_MIN`). */
  catalog: CatalogAugmentation;
  /** Quem pede, a partir do contexto da requisição. `undefined` é não autenticado. */
  resolveSubject: (ctx: Ctx, tag: number) => PermissionSubject | undefined;
  /** O erro lançado na negação. */
  createForbiddenError?: (message: string) => Error;
  /** O contexto da requisição corrente. `undefined` é fora de requisição. */
  getContext?: () => Ctx | undefined;
  /** Se o token vale no tenant do contexto. Informado, `isAllowed` e a rota negam no `false`. */
  isSameEntity?: (ctx: Ctx) => boolean;
  /** Campos a mais em cada recurso do catálogo (o módulo da tag, por exemplo). */
  describeResource?: (resource: CatalogResource) => Extra;
  messages?: PermissionMessagesInput;
  /** A resposta do `isAllowed` fora de requisição. */
  isAllowedOutsideRequest?: boolean;
  /** O que o `authorize` faz fora de requisição. */
  authorizeOutsideRequest?: OutsideRequestPolicy;
}

export interface AuthorizeOptions {
  /** A instância do recurso, para as condições `resource.*`. */
  resource?: Record<string, unknown>;
  /** Regra de negócio custom. Roda depois da matriz, sempre. */
  check?: PermissionCheck;
  /** Ignora só a matriz (grant e condições). O `check` continua obrigatório. */
  bypass?: boolean;
  /** Os argumentos do método, entregues ao `check`. */
  args?: unknown[];
}

export interface RequiresPermissionOptions {
  /** Monta a instância do recurso a partir dos argumentos do método. */
  resource?: (args: unknown[]) => Record<string, unknown> | undefined;
  /** Regra de negócio custom (pode ser async e consultar o banco). */
  check?: PermissionCheck;
  /** Ignora só a matriz. Para autoatendimento: o `check` continua obrigatório. */
  bypass?: boolean;
}

export interface RouteAccessInput<Ctx = unknown> {
  /** O contexto da requisição, já com o usuário verificado. */
  context: Ctx;
  tag: number;
  /** A ação da rota: `METHOD_TO_ACTION[req.method] ?? ""` ou a fixada pela rota. */
  action: ActionKey;
}

export interface RouteAccessDenial {
  status: 401 | 403 | 500;
  message: string;
}
