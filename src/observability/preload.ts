/**
 * Preload do Bun: sobe a observabilidade lendo só as envs, antes do código do projeto.
 *
 * Só no comando que sobe o servidor (script `start`/`dev`, `CMD` do Dockerfile), nunca no
 * `bunfig.toml`, que vale para todo comando `bun` do repositório:
 *
 * ```sh
 * bun --preload @mateusseiboth/ts-decorators/observability/preload src/index.ts
 * ```
 */
import { startObservability } from "./sdk";

startObservability();
