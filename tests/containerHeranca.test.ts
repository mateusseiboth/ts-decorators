import "reflect-metadata";
import { describe, expect, test } from "bun:test";

import { createContainer, createToken, Inject } from "../src/decorators/container";
import { Injectable } from "../src/decorators/Injectable";

interface Relogio {
  agora(): number;
}
const RELOGIO = createToken<Relogio>("Relogio");
const RELOGIO_FIXO: Relogio = { agora: () => 42 };

@Injectable()
class Banco {
  nome = "banco";
}

@Injectable()
class Outro {
  nome = "outro";
}

@Injectable()
class BaseRegistry {
  constructor(
    readonly banco: Banco,
    @Inject(RELOGIO) readonly relogio: Relogio,
  ) {}
}

@Injectable()
class RegistrySemConstrutor extends BaseRegistry {}

@Injectable()
class RegistryNeto extends RegistrySemConstrutor {}

@Injectable()
class RegistryComConstrutor extends BaseRegistry {
  constructor(
    banco: Banco,
    readonly outro: Outro,
  ) {
    super(banco, RELOGIO_FIXO);
  }
}

const buildContainer = () => {
  const c = createContainer();
  c.register(RELOGIO, { agora: () => 7 });
  return c;
};

describe("container: construtor herdado", () => {
  test("subclasse sem construtor recebe as dependências da base, inclusive o @Inject(token)", () => {
    const registry = buildContainer().get(RegistrySemConstrutor);
    expect(registry.banco).toBeInstanceOf(Banco);
    expect(registry.relogio.agora()).toBe(7);
  });

  test("dois níveis sem construtor sobem até a base", () => {
    const registry = buildContainer().get(RegistryNeto);
    expect(registry.banco).toBeInstanceOf(Banco);
    expect(registry.relogio.agora()).toBe(7);
  });

  test("metadata vazia na subclasse sem construtor não esconde a da base", () => {
    @Injectable()
    class ComMetadataVazia extends BaseRegistry {}
    Reflect.defineMetadata("design:paramtypes", [], ComMetadataVazia);
    const registry = buildContainer().get(ComMetadataVazia);
    expect(registry.banco).toBeInstanceOf(Banco);
    expect(registry.relogio.agora()).toBe(7);
  });

  test("subclasse com construtor próprio usa o dela, sem o @Inject da base no mesmo índice", () => {
    const registry = buildContainer().get(RegistryComConstrutor);
    expect(registry.outro).toBeInstanceOf(Outro);
    expect(registry.relogio).toBe(RELOGIO_FIXO);
  });
});

describe("container: classe que envolve outra", () => {
  test("construtor que só repassa os argumentos, sem metadata, injeta pela classe envolvida", () => {
    const Envolvida = class extends BaseRegistry {
      constructor(...args: any[]) {
        super(args[0], args[1]);
      }
    };
    const registry = buildContainer().get(Envolvida);
    expect(registry.banco).toBeInstanceOf(Banco);
    expect(registry.relogio.agora()).toBe(7);
  });
});
