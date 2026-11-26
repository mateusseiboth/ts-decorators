/**
 * defineConfig e @Config: variáveis de ambiente validadas com zod na SUBIDA. Falta ou valor
 * inválido derruba o boot com a lista de tudo que está errado, pelo nome da variável, sem mostrar
 * o valor (que pode ser segredo). O resultado é congelado: ninguém troca a configuração depois.
 *
 * Uso:
 *   const env = defineConfig(z.object({ DATABASE_URL: z.url(), PORT: z.coerce.number().default(3000) }));
 *
 *   @Config(EnvSchema) // para injetar pelo container
 *   class AppConfig { declare readonly PORT: number; }
 */
import type { z } from "zod";

export interface ConfigOptions {
  /** Default: `process.env`. */
  source?: Record<string, string | undefined>;
}

export interface ConfigIssue {
  /** A variável (ou o caminho dentro dela). */
  path: string;
  message: string;
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(
      `Configuração inválida:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`,
    );
    this.name = "ConfigError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function deepFreeze<T>(value: T): T {
  if (!isRecord(value) || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Só o caminho e a mensagem: o valor recebido nunca sai do processo. */
const toIssue = (issue: z.core.$ZodIssue): ConfigIssue => ({
  path: issue.path.map(String).join(".") || "(raiz)",
  message: issue.message,
});

export function defineConfig<S extends z.ZodType>(
  schema: S,
  options: ConfigOptions = {},
): Readonly<z.output<S>> {
  const parsed = schema.safeParse(options.source ?? process.env);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map(toIssue));
  if (!isRecord(parsed.data) || Array.isArray(parsed.data)) {
    throw new Error(
      "[@mateusseiboth/ts-decorators] O schema do defineConfig precisa devolver um objeto.",
    );
  }
  return deepFreeze(parsed.data);
}

/**
 * Decorator de classe: valida na DECLARAÇÃO da classe (a subida do módulo) e põe os valores no
 * protótipo, somente leitura. Declare os campos com `declare readonly`. A interface de mesmo nome
 * (`interface Classe extends z.infer<...>`) daria o tipo sem repetir, mas o lint barra a junção de
 * classe com interface (`no-unsafe-declaration-merging`).
 */
export function Config(schema: z.ZodType, options?: ConfigOptions) {
  const values = defineConfig(schema, options);
  return function <T extends { prototype: object }>(target: T, _context?: unknown): T {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(target.prototype, key, { value, enumerable: true, writable: false });
    }
    return target;
  };
}
