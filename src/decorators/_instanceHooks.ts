/**
 * Registro por instância para decorators de método que só fazem sentido com um `this`
 * (@OnShutdown, @HealthCheck), no mesmo molde do @Cron:
 *  - TC39 Stage 3: `context.addInitializer` registra quando a instância nasce.
 *  - Legacy: o decorator guarda a metadata no construtor, e `init(instance)` registra
 *    (o `container.get` chama sozinho). Idempotente por instância.
 *
 * Cada registro devolve a função que o desfaz; `dispose(instance)` chama todas.
 */

import "reflect-metadata";
import { appendMetadataItem } from "./_metadataList";
import { isDecoratorContext } from "./_proxy";

export interface MethodMeta<O> {
  methodName: string;
  options: O;
}

/**
 * Registra o método da instância e devolve a função que remove o registro. `invoke` chama o
 * método com o `this` da instância.
 */
export type RegisterMethod<O> = (
  instance: object,
  meta: MethodMeta<O>,
  invoke: () => unknown,
) => () => void;

export interface InstanceRegistry<O> {
  /** Legacy: guarda o método na metadata da classe. */
  addMeta(ctor: object, meta: MethodMeta<O>): void;
  /** Registra um método numa instância já criada. */
  attach(instance: object, meta: MethodMeta<O>): void;
  /** Legacy: registra os métodos guardados na metadata (uma vez por instância). */
  init(instance: object | undefined): void;
  /** Desfaz os registros da instância. */
  dispose(instance: object): void;
  /** Esquece quais instâncias já foram registradas (testes). */
  reset(): void;
}

/** `Classe.metodo`: o nome padrão do registro. */
export const buildMethodName = (instance: object, methodName: string): string =>
  `${instance.constructor?.name ?? "Anonimo"}.${methodName}`;

const buildInvoke = (instance: object, methodName: string) => () =>
  (instance as Record<string, () => unknown>)[methodName]?.();

export function createInstanceRegistry<O>(
  metadataKey: string,
  register: RegisterMethod<O>,
): InstanceRegistry<O> {
  let removersByInstance = new WeakMap<object, (() => void)[]>();

  const attach = (instance: object, meta: MethodMeta<O>) => {
    const removers = removersByInstance.get(instance) ?? [];
    removers.push(register(instance, meta, buildInvoke(instance, meta.methodName)));
    removersByInstance.set(instance, removers);
  };

  return {
    addMeta: (ctor, meta) => void appendMetadataItem(metadataKey, ctor, meta),
    attach,
    init: (instance) => {
      if (!instance || removersByInstance.has(instance)) return;
      const list: MethodMeta<O>[] = Reflect.getMetadata(metadataKey, instance.constructor) ?? [];
      for (const meta of list) attach(instance, meta);
    },
    dispose: (instance) => {
      for (const remove of removersByInstance.get(instance) ?? []) remove();
      removersByInstance.delete(instance);
    },
    reset: () => {
      removersByInstance = new WeakMap();
    },
  };
}

/** O decorator de método que alimenta o registro, nos dois padrões. */
export function makeInstanceMethodDecorator<O>(
  name: string,
  registry: InstanceRegistry<O>,
  options: O,
) {
  return function (...args: any[]): any {
    // TC39 Stage 3: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const context = args[1] as ClassMethodDecoratorContext;
      const methodName = String(context.name);
      context.addInitializer(function (this: unknown) {
        registry.attach(this as object, { methodName, options });
      });
      return args[0];
    }

    // Legacy: (target, propertyKey, descriptor)
    registry.addMeta(args[0].constructor, { methodName: String(args[1]), options });
    return args[2];
  };
}
