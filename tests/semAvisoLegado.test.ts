import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Cacheable } from "../src/decorators/cacheable";
import { DAOFor, getModel, ModelTagged } from "../src/decorators/getModel";
import { Field, InitFields } from "../src/decorators/initFields";
import { TransactionalClass } from "../src/decorators/transactional";
import { captureWarnings } from "./_helpers";

/** O pacote é do modo legado (`experimentalDecorators`): nenhum decorator avisa "LEGACY" no boot. */
describe("decorators no modo legado", () => {
  let cap: ReturnType<typeof captureWarnings>;
  beforeEach(() => {
    cap = captureWarnings();
  });
  afterEach(() => cap.restore());

  test("model, DAO e controller sobem sem aviso, e o static tag registra o model", () => {
    @InitFields
    @ModelTagged
    class SemAvisoModel {
      static tag = 99401;
      @Field() nome!: string;
    }
    @DAOFor(99401)
    class SemAvisoDAO {}
    @Cacheable()
    @TransactionalClass
    class SemAvisoController {
      async create() {}
    }

    expect([SemAvisoModel, SemAvisoDAO, SemAvisoController]).toHaveLength(3);
    expect(cap.warnings.filter((w) => w.includes("LEGACY"))).toEqual([]);
    expect(getModel(99401)).toBe(SemAvisoModel);
    expect((SemAvisoDAO as any).model).toBe(SemAvisoModel);
  });
});
