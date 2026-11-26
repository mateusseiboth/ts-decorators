/**
 * Detecção do formato do decorator (legado ou TC39 Stage 3).
 *
 * O pacote é do modo legado (`experimentalDecorators` + `emitDecoratorMetadata`): o `@Injectable`
 * depende do `design:paramtypes`, que só o legado emite. Os decorators que também entendem o
 * contexto do TC39 continuam entendendo, mas nenhum avisa quando é usado no legado.
 */

/** Detecta se o argumento é um DecoratorContext TC39 Stage 3 */
export function isDecoratorContext(arg: any): boolean {
  return (
    arg !== null &&
    arg !== undefined &&
    typeof arg === "object" &&
    typeof arg.kind === "string" &&
    ["class", "method", "getter", "setter", "field", "accessor"].includes(arg.kind)
  );
}

/** @deprecated O aviso de decorator legado saiu do pacote; a chamada não faz nada. */
export function warnLegacy(_name: string): void {}

/** @deprecated O aviso de decorator legado saiu do pacote; a chamada não faz nada. */
export function clearLegacyWarnings(): void {}

/** @deprecated O aviso de decorator legado saiu do pacote; a chamada não faz nada. */
export function setLegacyWarnings(_enabled: boolean): void {}
