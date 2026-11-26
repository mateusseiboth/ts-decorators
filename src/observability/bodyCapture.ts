/**
 * Marca de "esta requisição grava o corpo inteiro no span". O `@Auditable` marca as escritas que
 * audita; o `observeHttp` lê a marca quando a resposta termina.
 *
 * Fica no ponto de entrada principal e não importa `@opentelemetry/*`: o decorator mora lá.
 */

const _marcadas = new WeakSet<object>();

const isObjeto = (valor: unknown): valor is object => typeof valor === "object" && valor !== null;

/** Pede o corpo da requisição e o da resposta, inteiros, no span desta requisição. */
export function markBodyCapture(req: object): void {
  if (!isObjeto(req)) return;
  _marcadas.add(req);
}

/** `true` quando a requisição foi marcada com `markBodyCapture`. */
export function isBodyCaptureMarked(req: object): boolean {
  return isObjeto(req) && _marcadas.has(req);
}
