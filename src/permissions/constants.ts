import type { ActionKey, PermissionMessages } from "./types";

/** Verbo HTTP → ação CRUD. Verbo fora do mapa vira ação vazia, que nenhum grant concede. */
export const METHOD_TO_ACTION: Readonly<Record<string, ActionKey>> = Object.freeze({
  GET: "list",
  HEAD: "list",
  POST: "create",
  PUT: "edit",
  PATCH: "edit",
  DELETE: "delete",
});

/** Ações CRUD de todo Model descoberto (chave → rótulo exibido na matriz). */
export const CRUD_ACTIONS: Readonly<Record<ActionKey, string>> = Object.freeze({
  list: "Visualizar",
  create: "Inserir",
  edit: "Editar",
  delete: "Excluir",
});

/** Tags a partir desta são CUSTOMIZADAS (recurso sem Model). Evita colisão com os Models. */
export const CUSTOM_TAG_MIN = 9000;

/** O texto das negações. Cada app troca o que quiser em `configurePermissions({ messages })`. */
export const DEFAULT_PERMISSION_MESSAGES: Readonly<PermissionMessages> = Object.freeze({
  denied: "Você não tem permissão para executar esta ação.",
  entityDenied: "Você não tem permissão para acessar esta tenant.",
  unauthenticated: "Sessão inválida. Faça login novamente.",
  invalidTag: "Não foi possível verificar a permissão. Contate o suporte.",
  actionDenied: Object.freeze({
    list: "Você não tem permissão para acessar este recurso.",
    create: "Você não tem permissão para inserir neste recurso.",
    edit: "Você não tem permissão para editar neste recurso.",
    delete: "Você não tem permissão para excluir neste recurso.",
  }),
});
