/**
 * O INSERT na tabela `audit_log` do Postgres, para a escrita (na transação da requisição) e para o
 * lote de leituras (numa transação própria).
 *
 * Prisma 7 vai parametrizado; no Prisma 8 o lado cru sem parâmetros exige literais, então os
 * valores são escapados aqui (aspas dobradas) e o JSON entra com cast explícito.
 */
import { isPrisma8Tx, runStatement } from "../prisma8/client";
import type { AuditEntry } from "./auditable";

const AUDIT_INSERT = `INSERT INTO "audit_log" ("action", "entity", "entity_id", "user_id", "entidade", "before", "after", "timestamp", "method", "ip")`;

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return `'${value.toISOString()}'`;
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value as string | boolean | bigint);
  return `'${text.replace(/'/g, "''")}'`;
}

const valuesOf = (entry: AuditEntry): unknown[] => [
  entry.action,
  entry.entity,
  entry.entityId,
  entry.userId,
  entry.entidade,
  JSON.stringify(entry.before),
  JSON.stringify(entry.after),
  entry.timestamp,
  entry.method,
  entry.ip,
];

/** Uma linha do `VALUES` com literais, o `before` e o `after` como `jsonb`. */
function buildRowLiteral(entry: AuditEntry): string {
  const values = valuesOf(entry).map(sqlLiteral);
  values[5] = `${values[5]}::jsonb`;
  values[6] = `${values[6]}::jsonb`;
  return `(${values.join(", ")})`;
}

/** Um INSERT só para várias linhas, sem parâmetros: serve à transação do Prisma 7 e à do 8. */
export function buildAuditInsert(entries: readonly AuditEntry[]): string {
  return `${AUDIT_INSERT} VALUES ${entries.map(buildRowLiteral).join(", ")}`;
}

export async function insertAuditLog(tx: any, entry: AuditEntry): Promise<void> {
  if (isPrisma8Tx(tx)) {
    await runStatement(tx, buildAuditInsert([entry]));
    return;
  }
  await tx.$executeRawUnsafe(
    `${AUDIT_INSERT} VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    ...valuesOf(entry),
  );
}
