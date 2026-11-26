/**
 * App de verdade para o teste de integração: sobe com o preload da observabilidade
 * (`bun --preload src/observability/preload.ts`), importa o Express por `import` (ESM, como os
 * projetos) e sobe dois servidores: A chama B pelo `fetch` global.
 *
 * `FIXTURE_MODO` reproduz o que acontece depois do Express nos projetos:
 * - `https`: o `require("https")` direto;
 * - `cjs-https`: um pacote CommonJS que carrega o `https` (o axios, pelo follow-redirects);
 * - `unhooked`: o gancho do servidor HTTP sumiu por qualquer outro motivo.
 *
 * Imprime `{"pronto":{"a":<porta>,"b":<porta>}}` e espera o SIGTERM, que roda o desligamento
 * (o gancho da observabilidade descarrega spans e métricas antes de sair).
 */
import type { Server } from "node:http";
import { createRequire } from "node:module";

import express from "express";

import { enableGracefulShutdown } from "../../../src/decorators/shutdown";
import { observeHttp } from "../../../src/observability/index";

const require = createRequire(import.meta.url);

/** O `emit` embrulhado pela instrumentation-http guarda como se desfazer. */
const unwrapServerEmit = () => {
  const emit = require("http").Server.prototype.emit as { __unwrap?: () => void };
  emit.__unwrap?.();
};

const MODOS: Record<string, () => unknown> = {
  https: () => require("https"),
  "cjs-https": () => require("./cjsWithHttps.cjs"),
  unhooked: unwrapServerEmit,
};

MODOS[process.env.FIXTURE_MODO ?? ""]?.();

const listen = (app: express.Express) =>
  new Promise<{ server: Server; port: number }>((resolve) => {
    const server = app.listen(0, () =>
      resolve({ server, port: (server.address() as { port: number }).port }),
    );
  });

const b = express();
b.use(express.json());
b.use(observeHttp());
b.get("/api/destino", (req, res) => {
  res.json({ recebido: { "x-request-id": req.headers["x-request-id"] } });
});
const servidorB = await listen(b);

const a = express();
a.use(express.json());
a.use(observeHttp());
const itens = express.Router();
itens.get("/:id", (req, res) => {
  console.log("lendo item", { id: req.params.id });
  res.json({ id: req.params.id });
});
a.use("/api/itens", itens);
a.get("/encadeado", async (_req, res) => {
  const resposta = await fetch(`http://127.0.0.1:${servidorB.port}/api/destino`);
  res.json(await resposta.json());
});
a.get("/api/falha", (_req, res) => {
  res.status(500).json({ erro: "falhou" });
});
a.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
const servidorA = await listen(a);

enableGracefulShutdown({ server: servidorA.server, drainTimeoutMs: 100 });
process.on("SIGTERM", () => servidorB.server.close());

process.stdout.write(`${JSON.stringify({ pronto: { a: servidorA.port, b: servidorB.port } })}\n`);
