/**
 * Cache das metadatas reflexivas dos decorators (@Field, @NestedModel, @MaskSensitive).
 *
 * A resolução original percorre a cadeia de protótipos e lê `Symbol.metadata` a
 * CADA chamada — e isso acontece por requisição (getWhere/getColumns/getOrderBy)
 * e por campo (@AutoConvert). Como a metadata só muda quando uma classe é
 * DECLARADA, memorizar é seguro: qualquer registro novo chama
 * {@link bumpMetadataVersion} e todos os caches se invalidam sozinhos.
 */

let _version = 0;

/** Invalida todos os caches de metadata (chamado por cada registro de decorator). */
export function bumpMetadataVersion(): void {
  _version++;
}

/** Versão corrente da metadata registrada no processo. */
export function metadataVersion(): number {
  return _version;
}

/**
 * Descarta o que está memorizado. Útil em testes e em cenários de hot reload —
 * a próxima leitura recalcula a partir da metadata real.
 */
export function clearMetadataCache(): void {
  bumpMetadataVersion();
}

export interface MetadataCache<K extends object, V> {
  /** Devolve o valor memorizado ou calcula (e guarda) na primeira leitura. */
  get(key: K, compute: (key: K) => V): V;
}

/**
 * Cache por objeto (prototype ou construtor), com invalidação por versão.
 *
 * O `WeakMap` não segura a classe viva; a versão evita o clássico "decorei uma
 * classe depois e o cache ficou velho".
 */
export function createMetadataCache<K extends object, V>(): MetadataCache<K, V> {
  let store = new WeakMap<K, V>();
  let seen = _version;

  return {
    get(key, compute) {
      if (seen !== _version) {
        store = new WeakMap();
        seen = _version;
      }
      const cached = store.get(key);
      if (cached !== undefined) return cached;
      const value = compute(key);
      store.set(key, value);
      return value;
    },
  };
}
