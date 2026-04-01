/**
 * Utilitário para detecção de padrão de decorator (Legacy vs TC39 Stage 3).
 *
 * - Legacy (experimentalDecorators): TypeScript < 5 / flag ativada
 * - Novo (TC39 Stage 3): TypeScript 5+ padrão
 *
 * Quando um decorator é chamado no padrão legacy, emite um aviso no console
 * (uma vez por nome de decorator).
 */

const _legacyWarnings = new Set<string>();

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

/** Emite aviso de uso de decorator legacy (uma vez por nome) */
export function warnLegacy(name: string): void {
  if (_legacyWarnings.has(name)) return;
  _legacyWarnings.add(name);
  console.warn(
    `[@mateusseiboth/ts-commons] ⚠️  Decorator @${name} está sendo usado no padrão LEGACY (experimentalDecorators). ` +
      `Migre para o novo padrão TC39 Stage 3 decorators.`,
  );
}

/** Limpa os warnings registrados (útil para testes) */
export function clearLegacyWarnings(): void {
  _legacyWarnings.clear();
}
