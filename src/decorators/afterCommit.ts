/**
 * @AfterCommit(evento): o `@Emit` que espera o commit. O evento só sai depois que a transação em
 * uso COMITA, e nunca sai se ela voltar atrás. O payload é o mesmo do `@Emit`
 * (`{ result, args, instance }`), então os `@Listen` não mudam.
 *
 * A transação vem do contexto do handler, de `this.DAO.tx` ou de `this.tx`. Sem transação, o
 * evento sai na hora, como no `@Emit`.
 *
 * Uso:
 *   @AfterCommit("parcela.quitada")
 *   async quitar(id) { ...; return parcela; }
 */
import { eventBus } from "../events/eventBus";
import { afterCommit } from "../handlers/afterCommit";
import { findTransaction } from "../handlers/context";
import { makeMethodDecorator } from "./_method";

export function AfterCommit(event: string) {
  return makeMethodDecorator("AfterCommit", (original) => {
    return async function (this: any, ...args: any[]) {
      const result = await original.apply(this, args);
      afterCommit(findTransaction(this), () =>
        eventBus.emit(event, { result, args, instance: this }),
      );
      return result;
    };
  });
}
