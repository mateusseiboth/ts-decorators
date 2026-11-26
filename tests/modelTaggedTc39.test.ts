import { describe, expect, test } from "bun:test";

import { getModel, ModelTagged } from "../src/decorators/getModel";

/** Contexto TC39 que guarda os inicializadores, como o runtime: rodam depois dos campos estáticos. */
const createClassContext = (name: string) => {
  const initializers: Array<() => void> = [];
  const context = {
    kind: "class",
    name,
    metadata: {},
    addInitializer: (fn: () => void) => initializers.push(fn),
  } as unknown as ClassDecoratorContext;
  return {
    context,
    runInitializers: (target: unknown) => initializers.forEach((fn) => fn.call(target)),
  };
};

describe("@ModelTagged no TC39", () => {
  test("enxerga o static tag definido depois do decorator da classe", () => {
    class TagTardio {}
    const { context, runInitializers } = createClassContext("TagTardio");

    ModelTagged(TagTardio, context);
    (TagTardio as any).tag = 99201; // o static tag = N só existe depois do decorator
    runInitializers(TagTardio);

    expect(getModel(99201)).toBe(TagTardio);
  });

  test("sem tag nem depois dos campos estáticos, falha com o nome do model", () => {
    class SemTag {}
    const { context, runInitializers } = createClassContext("SemTag");

    ModelTagged(SemTag, context);

    expect(() => runInitializers(SemTag)).toThrow("SemTag não possui static tag");
  });
});
