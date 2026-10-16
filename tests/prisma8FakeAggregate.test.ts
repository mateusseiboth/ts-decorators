/**
 * A `FakeCollection` imita a superfície da coleção do Prisma 8 que os DAOs usam: além do
 * `count()`, o `aggregate` real tem `sum`/`avg`/`min`/`max`, e `with(fragmento)` aplica um pedaço
 * de consulta reaproveitável. Sem isso, um DAO nativo não tinha como ser testado com o fake.
 */
import { describe, expect, test } from "bun:test";

import { FakeCollection, type FakeContractModels } from "../src/testing/prisma8Fakes";

const models: FakeContractModels = { Arvore: { fields: ["id", "numero", "linha_id"] } };

describe("FakeCollection.aggregate", () => {
  test("count continua vindo de `count`", async () => {
    const arvores = new FakeCollection(models, "Arvore", { count: 3 });
    expect(await arvores.aggregate((a) => ({ n: a.count() }))).toEqual({ n: 3 });
  });

  test("max/min/sum/avg vêm de `agregados`, pelo nome do resultado", async () => {
    const arvores = new FakeCollection(models, "Arvore", { agregados: { maior: 7, soma: 20 } });
    const resultado = await arvores.aggregate((a) => ({
      maior: a.max("numero"),
      soma: a.sum("numero"),
      media: a.avg("numero"),
      menor: a.min("numero"),
    }));
    expect(resultado).toEqual({ maior: 7, soma: 20, media: null, menor: null });
  });

  test("registra o agregado pedido em `calls`", async () => {
    const arvores = new FakeCollection(models, "Arvore");
    await arvores.where({ linha_id: "l1" }).aggregate((a) => ({ maior: a.max("numero") }));
    expect(arvores.calls[0]).toMatchObject({
      terminal: "aggregate",
      data: { maior: { fn: "max", field: "numero" } },
    });
  });
});

describe("FakeCollection.with", () => {
  test("aplica o fragmento e devolve a coleção que ele montou", async () => {
    const arvores = new FakeCollection(models, "Arvore", { rows: [{ id: "a1" }] });
    const daLinha = (colecao: FakeCollection) => colecao.where({ linha_id: "l1" });
    await arvores.with(daLinha).all();
    expect(arvores.calls[0]!.state.where).toEqual([{ op: "eqObject", value: { linha_id: "l1" } }]);
  });
});
