/**
 * @SingleFlight e withSingleFlight: chamadas iguais que chegam enquanto a primeira ainda está em
 * andamento recebem a MESMA promessa, em vez de repetir a consulta. Ao terminar, a chave sai: a
 * próxima chamada roda de novo (não é cache).
 *
 * Uso:
 *   @SingleFlight()
 *   async findCotacao(moeda) { ... }
 *
 *   await withSingleFlight(`cotacao:${moeda}`, () => api.findCotacao(moeda));
 */

import { stableStringify } from "../functions/object";
import { makeMethodDecorator } from "./_method";

export interface SingleFlightOptions {
  /** Chave da chamada a partir dos argumentos. Default: os argumentos serializados. */
  key?: (...args: any[]) => string;
}

// Global: "Classe.metodo:chave" (ou a chave do withSingleFlight) → a promessa em andamento.
const _emAndamento = new Map<string, Promise<unknown>>();

const startChamada = <T>(key: string, fn: () => T | Promise<T>): Promise<T> => {
  // `resolve(fn())` dentro do executor: o erro síncrono de `fn` vira rejeição, como no assíncrono.
  const promessa = new Promise<T>((resolve) => resolve(fn()));
  const release = () => {
    if (_emAndamento.get(key) === promessa) _emAndamento.delete(key);
  };
  // Registrado antes de quem chamou: quando o chamador continua, a chave já saiu.
  promessa.then(release, release);
  _emAndamento.set(key, promessa);
  return promessa;
};

export function withSingleFlight<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const emAndamento = _emAndamento.get(key) as Promise<T> | undefined;
  return emAndamento ?? startChamada(key, fn);
}

export function SingleFlight(options?: SingleFlightOptions): (...args: any[]) => any {
  const buildChave = options?.key ?? ((...args: any[]) => stableStringify(args));
  return makeMethodDecorator("SingleFlight", (original, methodName) => {
    return function (this: any, ...args: any[]) {
      const escopo = `${this?.constructor?.name ?? "fn"}.${methodName}`;
      return withSingleFlight(`${escopo}:${buildChave(...args)}`, () => original.apply(this, args));
    };
  });
}
