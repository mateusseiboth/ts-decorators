const NUMERIC_FIELDS = ["number", "bigint", "decimal", "float"] as const;

/**
 * Monta o comparador de ordenação a partir do dado PLANO `filters.orderBy`
 * ({field, typeField}) — funções não atravessam a fronteira do worker, então o
 * app enriquece o filtro no enqueue e o comparador nasce aqui (worker e JSON).
 */
export function buildOrderByFunction(filters: any): ((a: any, b: any) => number) | undefined {
  const orderBy = filters?.orderBy;
  if (!orderBy?.field) return undefined;

  if (NUMERIC_FIELDS.includes(orderBy.typeField)) {
    return (a: any, b: any) => (Number(a[orderBy.field]) || 0) - (Number(b[orderBy.field]) || 0);
  }
  return (a: any, b: any) => String(a[orderBy.field]).localeCompare(String(b[orderBy.field]));
}
