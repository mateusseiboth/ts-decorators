/**
 * @Injectable() — Decorator de marcação para injeção de dependência.
 *
 * Deve ser aplicado como decorator MAIS INTERNO (mais próximo da classe),
 * para que seja executado ANTES de @Cacheable / @TransactionalClass.
 * Assim captura o `design:paramtypes` emitido pelo TypeScript antes que
 * outros decorators possam substituir a referência da classe.
 *
 * Exemplo de uso:
 * ```ts
 * @Cacheable({ ttl: 15_000 })
 * @TransactionalClass
 * @Injectable()              // <- innermost: roda primeiro
 * export class MeuController extends BaseController {
 *   constructor(private readonly dao: MeuDAO) { super(); }
 * }
 * ```
 *
 * Para portar para um pacote externo:
 * - copie este arquivo + `container.ts` juntos
 * - remova a dependência de `reflect-metadata` se já importada no entry point
 * - a chave `di:paramtypes` é o único acoplamento entre os dois arquivos
 */

import "reflect-metadata";

const DI_PARAMTYPES_KEY = "di:paramtypes";

export function Injectable(): ClassDecorator {
  return function (target: any) {
    // Captura design:paramtypes antes que decorators externos possam envolver a classe
    const deps: any[] = Reflect.getMetadata("design:paramtypes", target) ?? [];
    // Salva em chave própria — acessível via prototype chain se um decorator criar subclasse
    Reflect.defineMetadata(DI_PARAMTYPES_KEY, deps, target);
    return target;
  };
}
