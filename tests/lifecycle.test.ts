import {afterEach, describe, expect, test} from "bun:test";
import "reflect-metadata";
import {container} from "../src/decorators/container";
import {Scoped, Singleton, Transient} from "../src/decorators/lifecycle";

describe("Lifecycle decorators + container scopes", () => {
  afterEach(() => {
    container.clear();
    container.setScopeResolver(() => "global");
  });

  test("@Singleton retorna sempre a mesma instância", () => {
    @Singleton()
    class A {}
    expect(container.get(A)).toBe(container.get(A));
  });

  test("@Transient retorna instância nova a cada get", () => {
    @Transient()
    class B {}
    expect(container.get(B)).not.toBe(container.get(B));
  });

  test("default (sem decorator) é singleton", () => {
    class C {}
    expect(container.get(C)).toBe(container.get(C));
  });

  test("@Scoped retorna a mesma instância dentro do mesmo escopo e nova em outro", () => {
    let scope = "req-1";
    container.setScopeResolver(() => scope);

    @Scoped()
    class D {}

    const first = container.get(D);
    expect(container.get(D)).toBe(first);

    scope = "req-2";
    const second = container.get(D);
    expect(second).not.toBe(first);
  });

  test("@Scoped com keyFn próprio ignora o resolver global", () => {
    container.setScopeResolver(() => "global");
    let key = "k1";

    @Scoped(() => key)
    class E {}

    const first = container.get(E);
    key = "k2";
    expect(container.get(E)).not.toBe(first);
  });
});
