/**
 * Geradores dos assistentes (Tabela, Condicional, Cálculo, Agrupar). O usuário escolhe nas caixas
 * e o Studio escreve o Handlebars; nada aqui toca no DOM.
 */
export type CellFormat = "texto" | "numero" | "moeda" | "data" | "percentual";

export interface TableColumn {
  field: string;
  label: string;
  format: CellFormat;
}

const CELL_FORMATS: Record<CellFormat, (expr: string) => string> = {
  texto: (expr) => expr,
  numero: (expr) => `number ${expr}`,
  moeda: (expr) => `currency ${expr}`,
  data: (expr) => `formatDate ${expr}`,
  percentual: (expr) => `percent ${expr}`,
};

const NUMERIC_FORMATS: ReadonlySet<CellFormat> = new Set(["numero", "moeda", "percentual"]);
const SUMMABLE_FORMATS: ReadonlySet<CellFormat> = new Set(["numero", "moeda"]);

const formatCell = (format: CellFormat, expr: string) => `{{${CELL_FORMATS[format](expr)}}}`;
const formatTotal = (format: CellFormat, expr: string) =>
  `{{${CELL_FORMATS[format](`(${expr})`)}}}`;

const TH = "border-bottom: 2px solid #333; padding: 6px 8px; text-align: left;";
const TD = "border-bottom: 1px solid #ddd; padding: 6px 8px;";
const RIGHT = " text-align: right;";
const BOLD = " font-weight: bold;";

const alignOf = (column: TableColumn) => (NUMERIC_FORMATS.has(column.format) ? RIGHT : "");

export interface TableOptions {
  listExpr: string;
  columns: readonly TableColumn[];
  withIndex: boolean;
  withTotals: boolean;
}

function totalCell(column: TableColumn, index: number, options: TableOptions): string {
  const style = `${TD}${alignOf(column)}${BOLD}`;
  if (SUMMABLE_FORMATS.has(column.format)) {
    const total = formatTotal(column.format, `sum ${options.listExpr} "${column.field}"`);
    return `        <td style="${style}">${total}</td>`;
  }
  const label = index === 0 && !options.withIndex ? "Total" : "";
  return `        <td style="${style}">${label}</td>`;
}

export function buildTable(options: TableOptions): string {
  const { listExpr, columns, withIndex, withTotals } = options;
  const span = columns.length + (withIndex ? 1 : 0);
  const lines = [
    '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">',
    "  <thead>",
    "    <tr>",
    ...(withIndex ? [`      <th style="${TH} width: 36px;">#</th>`] : []),
    ...columns.map((c) => `      <th style="${TH}${alignOf(c)}">${c.label}</th>`),
    "    </tr>",
    "  </thead>",
    "  <tbody>",
    `    {{#each ${listExpr}}}`,
    "    <tr>",
    ...(withIndex ? [`      <td style="${TD}">{{index1 @index}}</td>`] : []),
    ...columns.map(
      (c) => `      <td style="${TD}${alignOf(c)}">${formatCell(c.format, c.field)}</td>`,
    ),
    "    </tr>",
    "    {{else}}",
    `    <tr><td colspan="${span}" style="${TD} text-align: center;">Nenhum registro.</td></tr>`,
    "    {{/each}}",
    "  </tbody>",
    ...(withTotals
      ? [
          "  <tfoot>",
          "    <tr>",
          ...(withIndex ? [`        <td style="${TD}${BOLD}">Total</td>`] : []),
          ...columns.map((column, index) => totalCell(column, index, options)),
          "    </tr>",
          "  </tfoot>",
        ]
      : []),
    "</table>",
  ];
  return lines.join("\n");
}

export type ConditionOperator =
  | "=="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "contem"
  | "preenchido"
  | "vazio";

export const OPERATORS_WITHOUT_VALUE: ReadonlySet<string> = new Set(["preenchido", "vazio"]);

export interface ConditionOptions {
  field: string;
  operator: ConditionOperator;
  value: string;
  withElse: boolean;
}

function literalOf(raw: string): string {
  const isNumber = raw !== "" && !Number.isNaN(Number(raw));
  const isBoolean = raw === "true" || raw === "false";
  return isNumber || isBoolean ? raw : `"${raw.replaceAll('"', '\\"')}"`;
}

export function buildCondition({ field, operator, value, withElse }: ConditionOptions): string {
  const operand = OPERATORS_WITHOUT_VALUE.has(operator) ? "" : ` ${literalOf(value.trim())}`;
  const inverse = withElse ? "{{else}}\n  \n" : "";
  return `{{#ifCond ${field} "${operator}"${operand}}}\n  \n${inverse}{{/ifCond}}`;
}

export type CalcOperation = "sum" | "avg" | "min" | "max" | "count";

export interface CalcOptions {
  operation: CalcOperation;
  listExpr: string;
  field: string;
  format: Extract<CellFormat, "numero" | "moeda">;
}

export function buildCalc({ operation, listExpr, field, format }: CalcOptions): string {
  if (operation === "count") return `{{count ${listExpr}}}`;
  return formatTotal(format, `${operation} ${listExpr} "${field}"`);
}

export interface GroupOptions {
  listExpr: string;
  groupField: string;
  /** Colunas da tabela de cada grupo. */
  columns: readonly TableColumn[];
  /** Campo somado no subtotal de cada grupo; vazio não mostra subtotal. */
  sumField: string;
}

export function buildGroup({ listExpr, groupField, columns, sumField }: GroupOptions): string {
  const subtotal = sumField
    ? [
        "    <tr>",
        `      <td colspan="${columns.length}" style="${TD}${RIGHT}${BOLD}">Subtotal: {{currency (sum items "${sumField}")}}</td>`,
        "    </tr>",
      ]
    : [];
  return [
    `{{#groupBy ${listExpr} "${groupField}"}}`,
    '  <h3 style="margin: 16px 0 4px;">{{key}} <small style="color: #666;">({{count}})</small></h3>',
    '  <table style="width: 100%; border-collapse: collapse; font-size: 12px;">',
    "    {{#each items}}",
    "    <tr>",
    ...columns.map(
      (c) => `      <td style="${TD}${alignOf(c)}">${formatCell(c.format, c.field)}</td>`,
    ),
    "    </tr>",
    "    {{/each}}",
    ...subtotal,
    "  </table>",
    "{{else}}",
    "  <p>Nenhum registro.</p>",
    "{{/groupBy}}",
  ].join("\n");
}
