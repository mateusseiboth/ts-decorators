import { describe, expect, test } from "bun:test";

import { FakeCollection, type FakeContractModels } from "../src/testing/prisma8Fakes";

const models: FakeContractModels = { Bairro: { fields: ["id", "name", "enabled"] } };

describe("FakeCollection: terminais de escrita", () => {
  test("create devolve a linha base mesclada com o payload e registra em writes", async () => {
    const col = new FakeCollection(models, "Bairro", { rows: [{ id: "1", enabled: true }] });
    const row = await col.create({ name: "Centro" });
    expect(row).toEqual({ id: "1", enabled: true, name: "Centro" });
    expect(col.writes).toEqual([
      { terminal: "create", state: { where: [], include: [] }, data: { name: "Centro" } },
    ]);
  });

  test("update devolve UMA linha ou null quando nada casou; updateAndCount devolve afetadas", async () => {
    const col = new FakeCollection(models, "Bairro", {
      rows: [{ id: "1", name: "a" }],
      afetadas: 3,
    });
    expect(await col.where({ id: "1" }).update({ name: "b" })).toEqual({ id: "1", name: "b" });
    expect(await col.where({ id: "1" }).updateAndCount({ name: "c" })).toBe(3);
    const vazio = new FakeCollection(models, "Bairro", { rows: [] });
    expect(await vazio.where({ id: "x" }).update({ name: "b" })).toBeNull();
    expect(col.writes.map((w) => w.terminal)).toEqual(["update", "updateAndCount"]);
    expect(col.writes[0]?.state.where).toEqual([{ op: "eqObject", value: { id: "1" } }]);
  });

  test("rows como função: update e delete devolvem null quando o filtro não casa linha", async () => {
    // O filtro com a versão não casa; o filtro só pelo id casa (é o que a trava otimista lê).
    const col = new FakeCollection(models, "Bairro", {
      rows: (state) => (state.where.length > 1 ? [] : [{ id: "1", name: "a" }]),
    });
    expect(await col.where({ id: "1" }).update({ name: "b" })).toEqual({ id: "1", name: "b" });
    expect(await col.where({ id: "1" }).where({ name: "x" }).update({ name: "b" })).toBeNull();
    expect(await col.where({ id: "1" }).where({ name: "x" }).delete()).toBeNull();
  });

  test("sem rows configuradas, update continua devolvendo o payload", async () => {
    const col = new FakeCollection(models, "Bairro");
    expect(await col.update({ name: "b" })).toEqual({ name: "b" });
  });

  test("upsert guarda conflictOn e devolve a linha existente quando há", async () => {
    const col = new FakeCollection(models, "Bairro", { rows: [{ id: "1", name: "ja" }] });
    const row = await col.upsert({
      create: { id: "2", name: "novo" },
      update: {},
      conflictOn: { name: "novo" },
    });
    expect(row).toEqual({ id: "1", name: "ja" });
    expect(col.writes[0]).toMatchObject({ terminal: "upsert", conflictOn: { name: "novo" } });
  });

  test("createAll, delete, deleteAndCount e groupBy", async () => {
    const col = new FakeCollection(models, "Bairro", {
      rows: [{ id: "1" }],
      count: 2,
      grupos: [{ enabled: true, n: 2 }],
    });
    expect(await col.createAll([{ id: "a" }, { id: "b" }])).toEqual([{ id: "a" }, { id: "b" }]);
    expect(await col.where({ id: "1" }).delete()).toEqual({ id: "1" });
    expect(await col.deleteAndCount()).toBe(2);
    expect(
      await col
        .where({ enabled: true })
        .groupBy("enabled")
        .aggregate(() => ({})),
    ).toEqual([{ enabled: true, n: 2 }]);
    expect(col.calls.at(-1)).toMatchObject({
      terminal: "groupBy",
      state: { groupBy: ["enabled"] },
    });
  });
});
