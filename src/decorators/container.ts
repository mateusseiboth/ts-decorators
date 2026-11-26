/**
 * Container DI — resolução automática via reflect-metadata com suporte a escopos.
 *
 * Resolve dependências recursivamente a partir do `design:paramtypes` ou do
 * `di:paramtypes` salvo por @Injectable().
 *
 * Escopos (definidos pelos decorators @Singleton / @Scoped / @Transient via a
 * chave de metadata `di:scope`):
 *  - "singleton" (default): uma instância por tipo durante todo o processo.
 *  - "scoped": uma instância por chave de escopo (ex.: por request). A chave é
 *    obtida pelo resolver configurável `setScopeResolver()` (default: "global").
 *  - "transient": uma instância nova a cada `get()`.
 *
 * Para portar para um pacote externo:
 * - copie `Injectable.ts` + este arquivo
 * - o único acoplamento é a constante `DI_PARAMTYPES_KEY`
 */

import "reflect-metadata";
import { logger } from "../functions/logger";
import { hasCronJobs, startCronJobs, stopCronJobs } from "./cron";
import { disposeHealthChecks, initHealthChecks } from "./healthCheck";
import { disposeListeners, hasListeners, initListeners } from "./listen";
import { initProcessors } from "./processor";
import { disposeShutdownHooks, initShutdownHooks } from "./shutdown";

const DI_PARAMTYPES_KEY = "di:paramtypes";
const DI_SCOPE_KEY = "di:scope";
const DI_SCOPE_KEYFN = "di:scopeKeyFn";
const DI_INJECT_KEY = "di:inject";

export type DiScope = "singleton" | "scoped" | "transient";

type ScopeResolver = () => string;

declare const TOKEN_TYPE: unique symbol;

/** Token que não é classe (interface, valor de configuração), tipado pelo que ele entrega. */
export interface InjectionToken<T> {
  readonly name: string;
  readonly [TOKEN_TYPE]?: T;
}

type Construtor<T> = new (...args: any[]) => T;

/** O que o container resolve: uma classe ou um token. */
export type Resolvable<T> = Construtor<T> | InjectionToken<T>;

const TOKENS = new WeakSet<object>();

/** Cria um token: `const RELOGIO = createToken<Relogio>("Relogio")`. */
export function createToken<T>(name: string): InjectionToken<T> {
  const token = Object.freeze({ name, toString: () => `InjectionToken(${name})` });
  TOKENS.add(token);
  return token as InjectionToken<T>;
}

const isToken = (valor: unknown): valor is InjectionToken<unknown> =>
  typeof valor === "object" && valor !== null && TOKENS.has(valor);

/**
 * Parâmetro do construtor resolvido por um token (`design:paramtypes` de uma interface é
 * `Object`): `constructor(@Inject(RELOGIO) relogio: Relogio)`. Modo legado.
 */
export function Inject(token: InjectionToken<unknown>): ParameterDecorator {
  return (target, _propertyKey, index) => {
    const mapa: Record<number, InjectionToken<unknown>> = {
      ...(Reflect.getOwnMetadata(DI_INJECT_KEY, target) ?? {}),
      [index]: token,
    };
    Reflect.defineMetadata(DI_INJECT_KEY, mapa, target);
  };
}

class Container {
  private readonly singletons = new Map<any, any>();
  /** scopeKey → (target → instance) */
  private readonly scoped = new Map<string, Map<any, any>>();
  private scopeResolver: ScopeResolver = () => "global";

  /** Define como a chave de escopo é resolvida (ex.: requestId do AsyncLocalStorage). */
  setScopeResolver(resolver: ScopeResolver): void {
    this.scopeResolver = resolver;
  }

  /** Resolve (ou cria) uma instância do tipo, respeitando o escopo declarado. */
  get<T>(target: Resolvable<T>): T {
    if (isToken(target)) return this.readToken(target);
    return this.build(target);
  }

  private readToken<T>(token: InjectionToken<T>): T {
    if (this.singletons.has(token)) return this.singletons.get(token) as T;
    throw new Error(
      `[@mateusseiboth/ts-decorators] Nada registrado para o token ${token.name}. Use container.register(token, valor).`,
    );
  }

  private build<T>(target: Construtor<T>): T {
    const scope: DiScope = Reflect.getMetadata(DI_SCOPE_KEY, target) ?? "singleton";

    const cached = this.readCache<T>(target, scope);
    if (cached !== undefined) return cached;

    const deps: any[] =
      (Reflect.getMetadata("design:paramtypes", target) as any[]) ??
      (Reflect.getMetadata(DI_PARAMTYPES_KEY, target) as any[]) ??
      [];

    const tokens: Record<number, InjectionToken<unknown>> = Reflect.getMetadata(
      DI_INJECT_KEY,
      target,
    ) ?? {};
    const injections = deps.map((dep: any, index: number) => this.get(tokens[index] ?? dep));
    const instance = new target(...injections);

    this.writeCache(target, scope, instance);
    // Assina @Listen, agenda @Cron, inicia @Processor e registra @OnShutdown e @HealthCheck
    // (no-op se não houver nenhum).
    initListeners(instance);
    startCronJobs(instance);
    initProcessors(instance);
    initShutdownHooks(instance as object);
    initHealthChecks(instance as object);
    warnIfLeaky(target, scope, instance);
    return instance;
  }

  /** Cancela assinaturas e timers da instância — o oposto do que o `get` liga. */
  private dispose(instance: any): void {
    disposeListeners(instance);
    stopCronJobs(instance);
    disposeShutdownHooks(instance);
    disposeHealthChecks(instance);
  }

  private resolveScopeKey(target: any): string {
    const keyFn = Reflect.getMetadata(DI_SCOPE_KEYFN, target) as ScopeResolver | undefined;
    return keyFn ? keyFn() : this.scopeResolver();
  }

  private readCache<T>(target: any, scope: DiScope): T | undefined {
    if (scope === "transient") return undefined;
    if (scope === "singleton") {
      return this.singletons.has(target) ? (this.singletons.get(target) as T) : undefined;
    }
    const bucket = this.scoped.get(this.resolveScopeKey(target));
    return bucket?.has(target) ? (bucket.get(target) as T) : undefined;
  }

  private writeCache(target: any, scope: DiScope, instance: any): void {
    if (scope === "transient") return;
    if (scope === "singleton") {
      this.singletons.set(target, instance);
      return;
    }
    const key = this.resolveScopeKey(target);
    let bucket = this.scoped.get(key);
    if (!bucket) {
      bucket = new Map();
      this.scoped.set(key, bucket);
    }
    bucket.set(target, instance);
  }

  /** Registra uma instância já construída (útil para testes e overrides). */
  register<T>(target: Resolvable<T>, instance: T): void {
    this.singletons.set(target, instance);
  }

  /** Descarta o cache de um escopo (ex.: ao finalizar uma request). */
  clearScope(scopeKey: string): void {
    const bucket = this.scoped.get(scopeKey);
    if (bucket) for (const instance of bucket.values()) this.dispose(instance);
    this.scoped.delete(scopeKey);
  }

  /** Remove todas as instâncias (útil em testes). */
  clear(): void {
    for (const instance of this.singletons.values()) this.dispose(instance);
    for (const bucket of this.scoped.values()) {
      for (const instance of bucket.values()) this.dispose(instance);
    }
    this.singletons.clear();
    this.scoped.clear();
  }
}

/**
 * Instância `transient` que assina eventos ou agenda cron vaza: ninguém guarda
 * a referência para cancelar depois. O aviso sai uma vez por classe.
 */
const _leakWarned = new WeakSet<object>();

function warnIfLeaky(target: any, scope: DiScope, instance: any): void {
  if (scope !== "transient" || _leakWarned.has(target)) return;
  if (!hasListeners(instance) && !hasCronJobs(instance)) return;
  _leakWarned.add(target);
  logger.warn(
    `[@mateusseiboth/ts-decorators] ⚠️  ${target.name} é @Transient e registra @Listen/@Cron: cada resolução deixa ` +
      `uma assinatura viva. Use @Singleton, ou @Scoped + container.clearScope(chave) ao fim do ` +
      `escopo, ou chame disposeListeners()/stopCronJobs() na mão.`,
  );
}

export type { Container };

/** O container global do processo. */
export const container = new Container();

/**
 * Um container próprio (por app, por teste): instâncias e escopos só dele, sem tocar no global.
 * Os decorators (`@Injectable`, `@Inject`, `@Singleton`...) valem para todos.
 */
export function createContainer(): Container {
  return new Container();
}
