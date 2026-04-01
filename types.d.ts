declare global {
  var _console: typeof Function;
}

// TC39 Stage 3 Decorators - Symbol.metadata polyfill para TypeScript
// Necessário enquanto a lib ESNext do TS não inclui Symbol.metadata nativamente
interface SymbolConstructor {
  readonly metadata: unique symbol;
}

export {};
