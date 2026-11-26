/** A negação padrão das permissões: o errorHandler do app responde 403 com `code: "FORBIDDEN"`. */
export class PermissionDeniedError extends Error {
  readonly status = 403;
  readonly statusCode = 403;
  readonly code = "FORBIDDEN";

  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}
