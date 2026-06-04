/**
 * Container DI — Singleton simples com resolução automática via reflect-metadata.
 *
 * Resolve dependências recursivamente a partir do `design:paramtypes` ou do
 * `di:paramtypes` salvo por @Injectable().
 *
 * Todas as instâncias são singletons (uma por tipo durante todo o ciclo de vida
 * do processo). Controllers/DAOs/Services devem ser STATELESS — sem estado
 * mutável de requisição.
 *
 * Para portar para um pacote externo:
 * - copie `Injectable.ts` + este arquivo
 * - o único acoplamento é a constante `DI_PARAMTYPES_KEY`
 */

import "reflect-metadata";

const DI_PARAMTYPES_KEY = "di:paramtypes";

class Container {
  private readonly instances = new Map<any, any>();

  /**
   * Resolve (ou cria) uma instância singleton do tipo informado.
   * As dependências do construtor são resolvidas recursivamente.
   */
  get<T>(target: new (...args: any[]) => T): T {
    if (this.instances.has(target)) {
      return this.instances.get(target) as T;
    }

    // Estratégia 1: design:paramtypes padrão (traversa prototype chain)
    // Estratégia 2: di:paramtypes salvo por @Injectable() (mesmo comportamento)
    // Estratégia 3: array vazio — classe sem dependências
    const deps: any[] =
      (Reflect.getMetadata("design:paramtypes", target) as any[]) ??
      (Reflect.getMetadata(DI_PARAMTYPES_KEY, target) as any[]) ??
      [];

    const injections = deps.map((dep: any) => this.get(dep));
    const instance = new target(...injections);

    this.instances.set(target, instance);
    return instance;
  }

  /**
   * Registra uma instância já construída (útil para testes e overrides).
   */
  register<T>(target: new (...args: any[]) => T, instance: T): void {
    this.instances.set(target, instance);
  }

  /**
   * Remove todas as instâncias (útil em testes).
   */
  clear(): void {
    this.instances.clear();
  }
}

export const container = new Container();
