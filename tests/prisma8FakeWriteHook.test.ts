import { afterEach, describe, expect, test } from "bun:test";

import { FakeCollection, setFakeWriteHook } from "../src/testing/prisma8Fakes";

const MODELS = { Bairro: { fields: ["id", "name", "createdBy", "modifiedBy"] } };

afterEach(() => setFakeWriteHook());

describe("gancho de escrita do FakeCollection", () => {
  test("sem gancho a linha entra como veio", async () => {
    const col = new FakeCollection(MODELS, "Bairro");
    await col.create({ name: "Centro" });
    expect(col.writes[0]?.data).toEqual({ name: "Centro" });
  });

  test("o gancho recebe terminal, model e colunas, e o que devolve é o registrado", async () => {
    const vistos: unknown[] = [];
    setFakeWriteHook((terminal, model, fields, data) => {
      vistos.push([terminal, model, fields]);
      return { ...data, createdBy: "u1" };
    });
    const col = new FakeCollection(MODELS, "Bairro");
    await col.create({ name: "Centro" });
    await col.createAll([{ name: "A" }, { name: "B" }]);
    await col.upsert({ create: { name: "C" }, update: {} });
    await col.update({ name: "D" });
    await col.updateAndCount({ name: "E" });

    expect(vistos).toEqual([
      ["create", "Bairro", MODELS.Bairro.fields],
      ["createAll", "Bairro", MODELS.Bairro.fields],
      ["createAll", "Bairro", MODELS.Bairro.fields],
      ["upsert", "Bairro", MODELS.Bairro.fields],
      ["update", "Bairro", MODELS.Bairro.fields],
      ["updateAndCount", "Bairro", MODELS.Bairro.fields],
    ]);
    expect(col.writes.map((w) => w.data)).toEqual([
      { name: "Centro", createdBy: "u1" },
      [
        { name: "A", createdBy: "u1" },
        { name: "B", createdBy: "u1" },
      ],
      { name: "C", createdBy: "u1" },
      { name: "D", createdBy: "u1" },
      { name: "E", createdBy: "u1" },
    ]);
  });

  test("a linha devolvida pelo create carrega o que o gancho acrescentou", async () => {
    setFakeWriteHook((_t, _m, _f, data) => ({ ...data, id: "gerado" }));
    const col = new FakeCollection(MODELS, "Bairro");
    expect(await col.create({ name: "Centro" })).toEqual({ name: "Centro", id: "gerado" });
  });
});
