/**
 * Assistentes: o usuário escolhe nas caixas e o Studio escreve o Handlebars (logic/snippets).
 * As listas oferecidas são as alcançáveis do ponto do cursor, já com a expressão relativa a ele.
 */
import { listExprAt, readFrames } from "../logic/context";
import type { FieldKind, ListInfo } from "../logic/dataSchema";
import {
  buildCalc,
  buildCondition,
  buildGroup,
  buildTable,
  OPERATORS_WITHOUT_VALUE,
  type CalcOperation,
  type CellFormat,
  type ConditionOperator,
  type TableColumn,
} from "../logic/snippets";
import {
  byId,
  closeDialog,
  fillSelect,
  h,
  inputById,
  openDialog,
  selectById,
  setError,
  toast,
} from "./dom";
import type { Editor } from "./editor";
import { state } from "./state";

const DEFAULT_FORMAT: Partial<Record<FieldKind, CellFormat>> = {
  numero: "numero",
  data: "data",
};

const FORMAT_OPTIONS: readonly { value: CellFormat; label: string }[] = [
  { value: "texto", label: "Texto" },
  { value: "numero", label: "Número" },
  { value: "moeda", label: "Moeda (R$)" },
  { value: "data", label: "Data" },
  { value: "percentual", label: "Percentual" },
];

const NUMERIC_KINDS: ReadonlySet<FieldKind> = new Set(["numero"]);
const COLUMN_KINDS: ReadonlySet<FieldKind> = new Set([
  "texto",
  "numero",
  "data",
  "simnao",
  "vazio",
]);

interface ReachableList {
  info: ListInfo;
  expr: string;
}

function reachableLists(textBefore: string): ReachableList[] {
  return state.lists.flatMap((info) => {
    const expr = listExprAt(info.path, textBefore);
    return expr ? [{ info, expr }] : [];
  });
}

const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1).replaceAll("_", " ");

function columnRow(field: { name: string; kind: FieldKind }): HTMLElement {
  const check = h("input", { attrs: { type: "checkbox", "data-field": field.name } });
  check.checked = true;
  const label = h("input", { attrs: { type: "text", value: capitalize(field.name) } });
  const format = h("select");
  fillSelect(format, FORMAT_OPTIONS);
  format.value = DEFAULT_FORMAT[field.kind] ?? "texto";
  return h("div", { class: "col-row" }, check, h("span", { text: field.name }), label, format);
}

function readColumns(container: HTMLElement): TableColumn[] {
  return [...container.querySelectorAll<HTMLElement>(".col-row")].flatMap((row) => {
    const [check, , label, format] = row.children as unknown as [
      HTMLInputElement,
      HTMLElement,
      HTMLInputElement,
      HTMLSelectElement,
    ];
    if (!check.checked) return [];
    return [
      { field: check.dataset.field ?? "", label: label.value, format: format.value as CellFormat },
    ];
  });
}

export class Wizards {
  private lists: ReachableList[] = [];

  constructor(private readonly editor: Editor) {
    selectById("tableList").addEventListener("change", () => this.renderTableColumns());
    byId("btnTableOk").addEventListener("click", () => this.insertTable());
    selectById("groupList").addEventListener("change", () => this.renderGroupFields());
    byId("btnGroupOk").addEventListener("click", () => this.insertGroup());
    selectById("condOp").addEventListener("change", () => this.syncConditionValue());
    byId("btnCondOk").addEventListener("click", () => this.insertCondition());
    selectById("calcList").addEventListener("change", () => this.renderCalcFields());
    selectById("calcOp").addEventListener("change", () => this.renderCalcFields());
    byId("btnCalcOk").addEventListener("click", () => this.insertCalc());
  }

  private prepareLists(selectId: string, preferredPath?: readonly string[]): boolean {
    this.lists = reachableLists(this.editor.textBefore());
    if (!this.lists.length) {
      toast("Carregue dados com uma lista que possa ser usada neste ponto do modelo.", true);
      return false;
    }
    fillSelect(
      selectById(selectId),
      this.lists.map((list, index) => ({
        value: String(index),
        label: `${list.info.label} (${list.expr})`,
      })),
    );
    const preferred = this.lists.findIndex(
      (list) => list.info.path.join(".") === preferredPath?.join("."),
    );
    selectById(selectId).value = String(Math.max(preferred, 0));
    return true;
  }

  private selectedList(selectId: string): ReachableList | undefined {
    return this.lists[Number(selectById(selectId).value)];
  }

  // ── Tabela ──────────────────────────────────────────────────────────────

  openTable(preferredPath?: readonly string[]): void {
    if (!this.prepareLists("tableList", preferredPath)) return;
    this.renderTableColumns();
    setError("tableError");
    openDialog("dlgTable");
  }

  private renderTableColumns(): void {
    const fields = this.selectedList("tableList")?.info.fields ?? [];
    byId("tableCols").replaceChildren(
      ...fields.filter((field) => COLUMN_KINDS.has(field.kind)).map(columnRow),
    );
  }

  private insertTable(): void {
    const list = this.selectedList("tableList");
    const columns = readColumns(byId("tableCols"));
    if (!list || !columns.length) {
      setError("tableError", "Escolha ao menos uma coluna.");
      return;
    }
    const table = buildTable({
      listExpr: list.expr,
      columns,
      withIndex: inputById("tableIndex").checked,
      withTotals: inputById("tableTotals").checked,
    });
    closeDialog("dlgTable");
    this.editor.insert(`\n${table}\n`);
    toast("Tabela inserida.");
  }

  // ── Agrupar ─────────────────────────────────────────────────────────────

  openGroup(): void {
    if (!this.prepareLists("groupList")) return;
    this.renderGroupFields();
    setError("groupError");
    openDialog("dlgGroup");
  }

  private renderGroupFields(): void {
    const fields = (this.selectedList("groupList")?.info.fields ?? []).filter((f) =>
      COLUMN_KINDS.has(f.kind),
    );
    fillSelect(
      selectById("groupField"),
      fields.map((f) => ({ value: f.name, label: f.name })),
    );
    fillSelect(selectById("groupSum"), [
      { value: "", label: "Sem subtotal" },
      ...fields
        .filter((f) => NUMERIC_KINDS.has(f.kind))
        .map((f) => ({ value: f.name, label: f.name })),
    ]);
    byId("groupCols").replaceChildren(...fields.map(columnRow));
  }

  private insertGroup(): void {
    const list = this.selectedList("groupList");
    const groupField = selectById("groupField").value;
    const columns = readColumns(byId("groupCols"));
    if (!list || !groupField || !columns.length) {
      setError("groupError", "Escolha o campo do grupo e ao menos uma coluna.");
      return;
    }
    const snippet = buildGroup({
      listExpr: list.expr,
      groupField,
      columns,
      sumField: selectById("groupSum").value,
    });
    closeDialog("dlgGroup");
    this.editor.insert(`\n${snippet}\n`);
    toast("Agrupamento inserido.");
  }

  // ── Condicional ─────────────────────────────────────────────────────────

  openCondition(): void {
    const frame = readFrames(this.editor.textBefore()).at(-1);
    const paths = suggestionPaths(frame?.abs ?? []);
    byId("fieldPaths").replaceChildren(
      ...paths.map((path) => h("option", { attrs: { value: path } })),
    );
    setError("condError");
    this.syncConditionValue();
    openDialog("dlgCond");
    inputById("condField").focus();
  }

  private syncConditionValue(): void {
    inputById("condValue").disabled = OPERATORS_WITHOUT_VALUE.has(selectById("condOp").value);
  }

  private insertCondition(): void {
    const field = inputById("condField").value.trim();
    const operator = selectById("condOp").value as ConditionOperator;
    const value = inputById("condValue").value;
    if (!field) {
      setError("condError", "Informe o campo.");
      return;
    }
    if (!OPERATORS_WITHOUT_VALUE.has(operator) && !value.trim()) {
      setError("condError", "Informe o valor da comparação.");
      return;
    }
    closeDialog("dlgCond");
    this.editor.insert(
      `\n${buildCondition({ field, operator, value, withElse: inputById("condElse").checked })}\n`,
    );
    toast("Condicional inserida. Escreva o conteúdo dentro dela.");
  }

  // ── Cálculo ─────────────────────────────────────────────────────────────

  openCalc(): void {
    if (!this.prepareLists("calcList")) return;
    this.renderCalcFields();
    setError("calcError");
    openDialog("dlgCalc");
  }

  private renderCalcFields(): void {
    const isCount = selectById("calcOp").value === "count";
    const fields = (this.selectedList("calcList")?.info.fields ?? []).filter((f) =>
      NUMERIC_KINDS.has(f.kind),
    );
    fillSelect(
      selectById("calcField"),
      fields.map((f) => ({ value: f.name, label: f.name })),
    );
    selectById("calcField").disabled = isCount;
    inputById("calcCurrency").disabled = isCount;
  }

  private insertCalc(): void {
    const list = this.selectedList("calcList");
    const operation = selectById("calcOp").value as CalcOperation;
    const field = selectById("calcField").value;
    if (!list) return;
    if (operation !== "count" && !field) {
      setError("calcError", "A lista escolhida não tem campos de número.");
      return;
    }
    const snippet = buildCalc({
      operation,
      listExpr: list.expr,
      field,
      format: inputById("calcCurrency").checked ? "moeda" : "numero",
    });
    closeDialog("dlgCalc");
    this.editor.insert(snippet);
    toast(`Cálculo inserido: ${snippet}`);
  }
}

/** Campos simples (não lista) visíveis do frame atual, para o campo da condicional. */
function suggestionPaths(frameAbs: readonly string[]): string[] {
  const list = state.lists.find((info) => [...info.path, "[]"].join(".") === frameAbs.join("."));
  if (list) return list.fields.filter((f) => f.kind !== "lista").map((f) => f.name);
  const walk = (nodes: typeof state.schema, prefix: string): string[] =>
    nodes.flatMap((node) => {
      if (node.kind === "lista") return [];
      if (node.kind === "grupo") return walk(node.children, `${prefix}${node.key}.`);
      return [`${prefix}${node.key}`];
    });
  return walk(state.schema, "");
}
