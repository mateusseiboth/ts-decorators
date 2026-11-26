/**
 * Dois operadores abriram o mesmo registro; o primeiro salvou. O segundo, ao salvar, mandou a
 * versão antiga: o UPDATE condicional não casou e o registro existe. Sem este erro, o segundo
 * apagaria a mudança do primeiro em silêncio.
 *
 * O `errorHandler` do app traduz pelo `statusCode` e pelo `code`.
 */
export class OptimisticLockError extends Error {
  readonly statusCode = 409;
  readonly code = "REGISTRO_ALTERADO";

  constructor(readonly id?: unknown) {
    super("O registro foi alterado por outro usuário. Recarregue a tela e tente de novo.");
    this.name = "OptimisticLockError";
  }
}
