/** A mensagem de qualquer coisa lançada, para o resultado do desligamento e das sondas. */
export const readErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
