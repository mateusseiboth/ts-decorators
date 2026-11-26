/**
 * `console.log/info/warn/error/debug` saindo no mesmo formato do `logger` (JSON em produção), sem
 * reescrever as chamadas dos projetos. O logger escreve direto no `process.stdout`: o console
 * redirecionado não volta para ele mesmo.
 */
import { writeLog } from "../functions/logger";

type MetodoDoConsole = "log" | "info" | "warn" | "error" | "debug";
type Nivel = Parameters<typeof writeLog>[0];

const NIVEL_POR_METODO: Record<MetodoDoConsole, Nivel> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

const METODOS = Object.keys(NIVEL_POR_METODO) as MetodoDoConsole[];

let _originais: Partial<Record<MetodoDoConsole, (...args: unknown[]) => void>> | undefined;

const restoreConsole = (): void => {
  if (!_originais) return;
  Object.assign(console, _originais);
  _originais = undefined;
};

/** Redireciona o console para o logger. Devolve a função que desfaz. Ligar de novo não empilha. */
export function patchConsole(): () => void {
  if (_originais) return () => {};
  _originais = Object.fromEntries(METODOS.map((metodo) => [metodo, console[metodo]]));
  for (const metodo of METODOS) {
    const nivel = NIVEL_POR_METODO[metodo];
    console[metodo] = (...args: unknown[]) => writeLog(nivel, args);
  }
  return restoreConsole;
}
