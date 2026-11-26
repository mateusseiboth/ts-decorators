/**
 * `_middlewares.ts` no roteamento por pasta: o `middlewares` que ele exporta vale para a pasta dele
 * e para todas as de baixo, antes do `middlewares` da própria rota. Sem isso, cada `index.ts` do
 * módulo repetia `export const middlewares = [moduloBase]`, e quem esquecia ficava sem.
 *
 * Ordem: globais do `folderRouter` → `_middlewares` da raiz para a folha → os da rota. O mesmo
 * handler em mais de um nível roda uma vez. A rota que não pode herdar (upload multipart, que não
 * aceita quem escreve no corpo antes do multer) exporta `inheritFolderMiddlewares = false`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import type { Server } from "http";
import { tmpdir } from "os";
import path from "path";

import express from "express";

import { folderRouter } from "../src/decorators/folder-router";
import { clearRegisteredRoutes } from "../src/decorators/route-registry";

/** Middleware de fixture: anota o próprio nome em `res.locals.ordem`. */
const marca = (nome: string) => `(req, res, next) => {
  res.locals.ordem = [...(res.locals.ordem ?? []), "${nome}"];
  next();
}`;

/** Rota de fixture: responde a ordem em que os middlewares rodaram. */
const rota = (extra = "") => `${extra}
export const registry = async (router) => {
  router.get("/", (req, res) => res.json(res.locals.ordem ?? []));
};
`;

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  // Toda montagem grava no registro global de rotas; não deixa sobra para outro arquivo de teste.
  clearRegisteredRoutes();
});

/** Escreve os arquivos (caminho relativo → conteúdo), monta o folderRouter e devolve a URL base. */
async function startApp(
  arquivos: Record<string, string>,
  globais: express.RequestHandler[] = [],
): Promise<string> {
  const raiz = mkdtempSync(path.join(tmpdir(), "bc-folder-mw-"));
  for (const [relativo, conteudo] of Object.entries(arquivos)) {
    const destino = path.join(raiz, relativo);
    mkdirSync(path.dirname(destino), { recursive: true });
    writeFileSync(destino, conteudo);
  }
  const app = express();
  await folderRouter(app, raiz, { middlewares: globais });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

const readOrdem = async (base: string, caminho: string) =>
  (await (await fetch(`${base}${caminho}`)).json()) as string[];

describe("folderRouter: _middlewares.ts", () => {
  test("vale para a pasta e as de baixo, depois dos globais e antes dos da rota", async () => {
    const global: express.RequestHandler = (_req, res, next) => {
      res.locals.ordem = ["global"];
      next();
    };
    const base = await startApp(
      {
        "modulo/api/_middlewares.ts": `export const middlewares = [${marca("modulo")}];`,
        "modulo/api/v1/recurso/index.ts": rota(`export const middlewares = [${marca("da-rota")}];`),
      },
      [global],
    );

    expect(await readOrdem(base, "/modulo/api/v1/recurso")).toEqual([
      "global",
      "modulo",
      "da-rota",
    ]);
  });

  test("pastas aninhadas somam, da raiz para a folha", async () => {
    const base = await startApp({
      "modulo/_middlewares.ts": `export const middlewares = [${marca("modulo")}];`,
      "modulo/api/_middlewares.ts": `export const middlewares = [${marca("api")}];`,
      "modulo/api/recurso/index.ts": rota(),
    });

    expect(await readOrdem(base, "/modulo/api/recurso")).toEqual(["modulo", "api"]);
  });

  test("não vaza para a pasta irmã", async () => {
    const base = await startApp({
      "modulo/_middlewares.ts": `export const middlewares = [${marca("modulo")}];`,
      "modulo/recurso/index.ts": rota(),
      "outro/recurso/index.ts": rota(),
    });

    expect(await readOrdem(base, "/modulo/recurso")).toEqual(["modulo"]);
    expect(await readOrdem(base, "/outro/recurso")).toEqual([]);
  });

  test("o mesmo handler na pasta e na rota roda uma vez", async () => {
    const base = await startApp({
      "modulo/_middlewares.ts": `export const moduloBase = ${marca("modulo")};
export const middlewares = [moduloBase];`,
      "modulo/recurso/index.ts": rota(`import { moduloBase } from "../_middlewares.ts";
export const middlewares = [moduloBase];`),
    });

    expect(await readOrdem(base, "/modulo/recurso")).toEqual(["modulo"]);
  });

  test("`inheritFolderMiddlewares = false` fica só com os da rota", async () => {
    const base = await startApp({
      "modulo/_middlewares.ts": `export const middlewares = [${marca("modulo")}];`,
      "modulo/upload/index.ts": rota(`export const inheritFolderMiddlewares = false;
export const middlewares = [${marca("da-rota")}];`),
    });

    expect(await readOrdem(base, "/modulo/upload")).toEqual(["da-rota"]);
  });

  test("`_middlewares.ts` sem `middlewares` exportado não muda nada", async () => {
    const base = await startApp({
      "modulo/_middlewares.ts": `export const moduloBase = ${marca("modulo")};`,
      "modulo/recurso/index.ts": rota(),
    });

    expect(await readOrdem(base, "/modulo/recurso")).toEqual([]);
  });

  test("`_middlewares.ts` passa pela mesma checagem de conteúdo suspeito das rotas", async () => {
    await expect(
      startApp({
        "modulo/_middlewares.ts": `import "child_process";
export const middlewares = [];`,
        "modulo/recurso/index.ts": rota(),
      }),
    ).rejects.toThrow("Arquivo suspeito detectado.");
  });
});
