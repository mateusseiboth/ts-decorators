#!/usr/bin/env bun
/**
 * CLI do ts-decorators — `bunx ts-decorators <comando>`.
 * Comandos resolvidos por strategy map; comando novo = uma entrada.
 */
import { runStudio } from "./studio";

type Command = (args: string[]) => Promise<void>;

const commands: Record<string, Command> = {
  studio: runStudio,
  help: async () => printHelp(),
};

function printHelp(): void {
  console.log(`ts-decorators CLI

Uso: bunx ts-decorators <comando> [opções]

Comandos:
  studio [--port 4123]   Editor de templates HBS com preview em tempo real
                         (dados tratados via rota /data do app + token).
  help                   Mostra esta ajuda.
`);
}

const [, , commandName = "help", ...args] = process.argv;
const command = commands[commandName];

if (!command) {
  console.error(`Comando desconhecido: "${commandName}"\n`);
  printHelp();
  process.exit(1);
}

await command(args);
