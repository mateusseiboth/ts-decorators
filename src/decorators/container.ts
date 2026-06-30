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
import {initListeners} from "./listen";
import {startCronJobs} from "./cron";
import {initProcessors} from "./processor";

const DI_PARAMTYPES_KEY = "di:paramtypes";
const DI_SCOPE_KEY = "di:scope";
const DI_SCOPE_KEYFN = "di:scopeKeyFn";

export type DiScope = "singleton" | "scoped" | "transient";

type ScopeResolver = () => string;

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
  get<T>(target: new (...args: any[]) => T): T {
    const scope: DiScope = Reflect.getMetadata(DI_SCOPE_KEY, target) ?? "singleton";

    const cached = this.readCache<T>(target, scope);
    if (cached !== undefined) return cached;

    const deps: any[] =
      (Reflect.getMetadata("design:paramtypes", target) as any[]) ??
      (Reflect.getMetadata(DI_PARAMTYPES_KEY, target) as any[]) ??
      [];

    const injections = deps.map((dep: any) => this.get(dep));
    const instance = new target(...injections);

    this.writeCache(target, scope, instance);
    // Assina @Listen, agenda @Cron e inicia @Processor (no-op se não houver nenhum).
    initListeners(instance);
    startCronJobs(instance);
    initProcessors(instance);
    return instance;
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
  register<T>(target: new (...args: any[]) => T, instance: T): void {
    this.singletons.set(target, instance);
  }

  /** Descarta o cache de um escopo (ex.: ao finalizar uma request). */
  clearScope(scopeKey: string): void {
    this.scoped.delete(scopeKey);
  }

  /** Remove todas as instâncias (útil em testes). */
  clear(): void {
    this.singletons.clear();
    this.scoped.clear();
  }
}

export const container = new Container();
