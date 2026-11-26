/**
 * Helper interno para criar decorators de MÉTODO que suportam tanto o padrão
 * legacy (experimentalDecorators) quanto o TC39 Stage 3, evitando duplicar a
 * detecção de contexto em cada decorator.
 *
 * `build(original, methodName)` deve retornar a função substituta do método.
 */

import { isDecoratorContext, warnLegacy } from "./_proxy";

export type MethodWrapper = (original: Function, methodName: string) => Function;

const isAsyncFunction = (fn: unknown): boolean =>
  typeof fn === "function" && fn.constructor.name === "AsyncFunction";

/**
 * Método `async` continua `async` depois de decorado; o síncrono continua síncrono.
 *
 * Decorator de classe que só envolve `AsyncFunction` (o `@Transaction()` dos apps) não enxergava
 * o método cujo substituto é uma `function` comum: o método ficava sem transação, em silêncio.
 * O envelope guarda o `this` e o nome do método original.
 */
export function matchAsync(original: Function, substituto: Function): Function {
  if (!isAsyncFunction(original) || isAsyncFunction(substituto)) return substituto;
  const envelope = async function (this: unknown, ...args: unknown[]) {
    return substituto.apply(this, args);
  };
  Object.defineProperty(envelope, "name", { value: original.name, configurable: true });
  return envelope;
}

export function makeMethodDecorator(name: string, build: MethodWrapper) {
  const buildMatching: MethodWrapper = (original, methodName) =>
    matchAsync(original, build(original, methodName));

  return function (...args: any[]): any {
    // TC39 Stage 3: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const original = args[0] as Function;
      const methodName = String(args[1].name);
      return buildMatching(original, methodName);
    }

    // Legacy: (target, propertyKey, descriptor)
    warnLegacy(name);
    const propertyKey = args[1] as string;
    const descriptor = args[2] as PropertyDescriptor;
    descriptor.value = buildMatching(descriptor.value, propertyKey);
    return descriptor;
  };
}

/** Um método que o decorator de classe pode envolver. */
export interface MetodoDaClasse {
  name: string;
  /** A função como está hoje: a da própria classe, ou a herdada. */
  original: Function;
}

/**
 * Os métodos da classe e os HERDADOS das classes base, o mais específico primeiro.
 *
 * Decorator de classe que olha só o `prototype` da classe decorada não enxerga o `create` que
 * mora no controller base: a classe ficava sem cache, sem auditoria e sem SAVEPOINT, em silêncio.
 */
export function findMetodosDaClasse(prototype: object): MetodoDaClasse[] {
  const metodos = new Map<string, Function>();
  for (
    let atual: object | null = prototype;
    atual && atual !== Object.prototype;
    atual = Object.getPrototypeOf(atual)
  ) {
    for (const name of Object.getOwnPropertyNames(atual)) {
      if (name === "constructor" || metodos.has(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(atual, name);
      if (typeof descriptor?.value === "function") metodos.set(name, descriptor.value);
    }
  }
  return [...metodos].map(([name, original]) => ({ name, original }));
}

type BuildDoMetodo = (metodo: MetodoDaClasse) => Function | undefined;

/** Uma camada é um decorator de classe aplicado ao método. */
interface Camada {
  marca: symbol;
  build: BuildDoMetodo;
}

/** O que cada método envolvido carrega: a função sem decorator nenhum e as camadas, de dentro para fora. */
interface Envolvido {
  cru: Function;
  camadas: readonly Camada[];
}

const ENVOLVIDO = Symbol("ts-decorators:metodo-envolvido");

const readEnvolvido = (metodo: Function): Envolvido =>
  (metodo as any)[ENVOLVIDO] ?? { cru: metodo, camadas: [] };

const applyCamadas = (name: string, { cru, camadas }: Envolvido): Function =>
  camadas.reduce((original, camada) => camada.build({ name, original }) ?? original, cru);

/**
 * Envolve os métodos escolhidos da classe, herdados inclusive. O método que envolve fica no
 * `prototype` da classe DECORADA: a classe base e as irmãs não mudam.
 *
 * `marca` identifica o decorator. Quando o método herdado já chega envolvido por ele (a classe
 * base também é decorada), a camada da base é TROCADA pela desta classe, no mesmo lugar: o
 * efeito acontece uma vez só, com o nome e as opções da classe decorada, e as camadas dos outros
 * decorators da base continuam onde estavam.
 */
export function wrapMetodosDaClasse(
  constructor: { prototype: object },
  marca: symbol,
  build: BuildDoMetodo,
): void {
  for (const { name, original } of findMetodosDaClasse(constructor.prototype)) {
    // Só entra o método que este decorator envolve; o `build` decide pelo nome.
    if (!build({ name, original })) continue;

    const atual = readEnvolvido(original);
    const hasCamada = atual.camadas.some((camada) => camada.marca === marca);
    const camadas = hasCamada
      ? atual.camadas.map((camada) => (camada.marca === marca ? { marca, build } : camada))
      : [...atual.camadas, { marca, build }];
    const envolvido: Envolvido = { cru: atual.cru, camadas };
    const substituto = applyCamadas(name, envolvido);

    Object.defineProperty(substituto, ENVOLVIDO, { value: envolvido });
    Object.defineProperty(constructor.prototype, name, {
      value: substituto,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
