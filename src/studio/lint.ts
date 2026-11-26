/**
 * Análise estática do modelo Handlebars para o painel "Problemas" do Studio.
 *
 * Percorre a AST do `Handlebars.parse` acompanhando o contexto de dados de cada trecho (raiz,
 * item do `each`, objeto do `with`, grupo do `groupBy`) contra uma AMOSTRA dos dados carregados.
 * Só acusa campo inexistente quando a amostra permite afirmar: lista vazia, valor nulo ou dado não
 * carregado viram "desconhecido" e não geram aviso, para não gritar falso positivo.
 *
 * As mensagens são para o usuário final do Studio (setor de qualidade), não para o programador.
 */
import Handlebars from "handlebars";

export interface TemplateProblem {
  severity: "error" | "warning";
  message: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

export interface LintTemplateOptions {
  /** Amostra dos dados do relatório. Vazio ou ausente desliga a checagem de campos. */
  data?: unknown;
  /** Funções registradas (as nativas do Handlebars e as do relatório). */
  helpers: ReadonlySet<string>;
  /** Blocos reutilizáveis (`{{> nome}}`) disponíveis. */
  partials: ReadonlySet<string>;
}

type Node = hbs.AST.Node;
type Program = hbs.AST.Program;
type PathExpression = hbs.AST.PathExpression;
type Expression = hbs.AST.Expression;
type Hash = hbs.AST.Hash;

/** Valor da amostra que não dá para conferir (lista vazia, nulo, sem dados). */
const UNKNOWN = Symbol("desconhecido");
/** O objeto da amostra existe e não tem a chave. */
const MISSING = Symbol("inexistente");

type Sample = unknown;

interface Scope {
  readonly root: Sample;
  readonly frames: readonly Sample[];
  readonly params: ReadonlyMap<string, Sample>;
}

interface Walk {
  readonly options: LintTemplateOptions;
  readonly problems: TemplateProblem[];
}

// ── Amostra ────────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function lookupParts(start: Sample, parts: readonly string[]): Sample {
  let current = start;
  for (const part of parts) {
    if (!isRecord(current)) return UNKNOWN;
    if (!Object.hasOwn(current, part)) return MISSING;
    current = current[part];
  }
  return current;
}

function firstItem(list: Sample): Sample {
  if (Array.isArray(list)) return list.length ? list[0] : UNKNOWN;
  if (!isRecord(list)) return UNKNOWN;
  const values = Object.values(list);
  return values.length ? values[0] : UNKNOWN;
}

function rootSample(data: unknown): Sample {
  return isRecord(data) && Object.keys(data).length ? data : UNKNOWN;
}

function resolvePath(path: PathExpression, scope: Scope): Sample {
  const [head = "", ...rest] = path.parts;
  if (path.data) return head === "root" ? lookupParts(scope.root, rest) : UNKNOWN;
  if (path.depth === 0 && scope.params.has(head)) return lookupParts(scope.params.get(head), rest);
  const frame = scope.frames[scope.frames.length - 1 - path.depth];
  return lookupParts(frame ?? UNKNOWN, path.parts);
}

// ── Troca de contexto dos blocos ─────────────────────────────────────────────────────────────

interface ChildContext {
  context: Sample;
  blockParams: Sample[];
}

type ContextSwitch = (args: Sample[]) => ChildContext | null;

function groupSample(list: Sample, field: Sample): Sample {
  if (!Array.isArray(list) || !list.length || typeof field !== "string") return UNKNOWN;
  return { key: lookupParts(list[0], field.split(".")), items: list, count: list.length };
}

const eachContext: ContextSwitch = ([list]) => ({
  context: firstItem(list),
  blockParams: [firstItem(list), 0],
});

const withContext: ContextSwitch = ([value]) => ({ context: value, blockParams: [value] });

/** Bloco sem função registrada (`{{#itens}}`): o Handlebars itera lista e entra em objeto. */
const sectionContext: ContextSwitch = ([value]) => {
  if (Array.isArray(value)) return eachContext([value]);
  return isRecord(value) ? withContext([value]) : null;
};

const CONTEXT_SWITCH: Record<string, ContextSwitch> = {
  each: eachContext,
  with: withContext,
  groupBy: ([list, field]) => withContext([groupSample(list, field)]),
};

const keepContext: ContextSwitch = () => null;

/** Blocos nativos que quebram em tempo de execução sem o parâmetro. */
const REQUIRED_PARAM: Record<string, string> = {
  each: "Informe a lista do {{#each}}.",
  with: "Informe o campo do {{#with}}.",
  if: "Informe a condição do {{#if}}.",
  unless: "Informe a condição do {{#unless}}.",
};

// ── Problemas ────────────────────────────────────────────────────────────────────────────────

function report(walk: Walk, severity: TemplateProblem["severity"], message: string, node: Node) {
  walk.problems.push({
    severity,
    message,
    line: node.loc.start.line,
    column: node.loc.start.column + 1,
  });
}

const isSimpleName = (path: PathExpression) =>
  !path.data && path.depth === 0 && path.parts.length === 1;

const isHelper = (walk: Walk, path: PathExpression) =>
  isSimpleName(path) && walk.options.helpers.has(path.original);

function checkField(walk: Walk, path: PathExpression, scope: Scope): Sample {
  const value = resolvePath(path, scope);
  if (value === MISSING) {
    report(walk, "warning", `O campo ${path.original} não existe nos dados carregados.`, path);
    return UNKNOWN;
  }
  return value;
}

// ── Expressões ───────────────────────────────────────────────────────────────────────────────

function visitCall(
  walk: Walk,
  path: PathExpression,
  params: readonly Expression[],
  hash: Hash | undefined,
  scope: Scope,
): Sample[] {
  const args = params.map((param) => visitExpression(walk, param, scope));
  for (const pair of hash?.pairs ?? []) visitExpression(walk, pair.value, scope);
  if (!isHelper(walk, path)) report(walk, "error", `A função ${path.original} não existe.`, path);
  return args;
}

type ExpressionVisitor = (walk: Walk, node: Expression, scope: Scope) => Sample;

const EXPRESSION_VISITORS: Record<string, ExpressionVisitor> = {
  PathExpression: (walk, node, scope) => checkField(walk, node as PathExpression, scope),
  SubExpression: (walk, node, scope) => {
    const sub = node as hbs.AST.SubExpression;
    visitCall(walk, sub.path, sub.params, sub.hash, scope);
    return UNKNOWN;
  },
  StringLiteral: (_walk, node) => (node as hbs.AST.StringLiteral).value,
  NumberLiteral: (_walk, node) => (node as hbs.AST.NumberLiteral).value,
  BooleanLiteral: (_walk, node) => (node as hbs.AST.BooleanLiteral).value,
};

function visitExpression(walk: Walk, node: Expression, scope: Scope): Sample {
  return EXPRESSION_VISITORS[node.type]?.(walk, node, scope) ?? UNKNOWN;
}

// ── Comandos ─────────────────────────────────────────────────────────────────────────────────

function visitMustache(walk: Walk, node: hbs.AST.MustacheStatement, scope: Scope): void {
  if (node.path.type !== "PathExpression") return;
  const path = node.path as PathExpression;
  const isCall = node.params.length > 0 || (node.hash?.pairs.length ?? 0) > 0;
  if (isCall) {
    visitCall(walk, path, node.params, node.hash, scope);
    return;
  }
  if (isHelper(walk, path)) return;
  checkField(walk, path, scope);
}

function blockArgs(walk: Walk, node: hbs.AST.BlockStatement, scope: Scope): Sample[] {
  const name = node.path.original;
  const missingParam = REQUIRED_PARAM[name];
  if (missingParam && !node.params.length) {
    report(walk, "error", missingParam, node.path);
    return [];
  }
  if (node.params.length || isHelper(walk, node.path)) {
    return visitCall(walk, node.path, node.params, node.hash, scope);
  }
  return [checkField(walk, node.path, scope)];
}

function contextSwitchOf(walk: Walk, node: hbs.AST.BlockStatement): ContextSwitch {
  const name = node.path.original;
  const known = CONTEXT_SWITCH[name];
  if (known) return known;
  return isHelper(walk, node.path) || node.params.length ? keepContext : sectionContext;
}

function childScope(scope: Scope, child: ChildContext | null, program: Program): Scope {
  if (!child) return scope;
  const params = new Map(scope.params);
  (program.blockParams ?? []).forEach((name, index) => {
    params.set(name, child.blockParams[index] ?? UNKNOWN);
  });
  return { root: scope.root, frames: [...scope.frames, child.context], params };
}

function visitBlock(walk: Walk, node: hbs.AST.BlockStatement, scope: Scope): void {
  const args = blockArgs(walk, node, scope);
  const child = contextSwitchOf(walk, node)(args);
  if (node.program) visitProgram(walk, node.program, childScope(scope, child, node.program));
  if (node.inverse) visitProgram(walk, node.inverse, scope);
}

function visitPartial(walk: Walk, node: hbs.AST.PartialStatement): void {
  if (node.name.type !== "PathExpression") return;
  const name = (node.name as PathExpression).original;
  if (walk.options.partials.has(name)) return;
  report(walk, "warning", `O bloco {{> ${name}}} não existe.`, node.name);
}

type StatementVisitor = (walk: Walk, node: Node, scope: Scope) => void;

const STATEMENT_VISITORS: Record<string, StatementVisitor> = {
  MustacheStatement: (walk, node, scope) =>
    visitMustache(walk, node as hbs.AST.MustacheStatement, scope),
  BlockStatement: (walk, node, scope) => visitBlock(walk, node as hbs.AST.BlockStatement, scope),
  PartialStatement: (walk, node) => visitPartial(walk, node as hbs.AST.PartialStatement),
};

function visitProgram(walk: Walk, program: Program, scope: Scope): void {
  for (const statement of program.body) {
    STATEMENT_VISITORS[statement.type]?.(walk, statement, scope);
  }
}

// ── Erros de sintaxe ─────────────────────────────────────────────────────────────────────────

interface OpenBlock {
  name: string;
  line: number;
  column: number;
}

const RE_BLOCK_TAG = /\{\{~?\s*([#^/])\s*([^\s}~]+)/g;

/** Último bloco aberto sem fechamento, para apontar a linha do `{{#x}}` e não a do fim do texto. */
function findUnclosedBlock(template: string): OpenBlock | undefined {
  const stack: OpenBlock[] = [];
  for (const match of template.matchAll(RE_BLOCK_TAG)) {
    const before = template.slice(0, match.index);
    const line = before.split("\n").length;
    const column = match.index - before.lastIndexOf("\n");
    const [, kind, name = ""] = match;
    if (kind === "/") stack.pop();
    if (kind !== "/") stack.push({ name, line, column });
  }
  return stack.at(-1);
}

interface ParseFailure {
  message: string;
  lineNumber?: number;
  column?: number;
}

type SyntaxRule = (template: string, error: ParseFailure) => TemplateProblem | null;

const RE_MISMATCH = /^(\S+) doesn't match (\S+)/;
const RE_PARSE_LINE = /(?:Parse|Lexical) error on line (\d+)/;

const SYNTAX_RULES: readonly SyntaxRule[] = [
  (_template, error) => {
    const [, opened, closed] = RE_MISMATCH.exec(error.message) ?? [];
    if (!opened) return null;
    return {
      severity: "error",
      message: `O bloco {{#${opened}}} foi fechado com {{/${closed}}}. Use {{/${opened}}}.`,
      line: error.lineNumber ?? 1,
      column: (error.column ?? 0) + 1,
    };
  },
  (template, error) => {
    if (!error.message.includes("got 'EOF'")) return null;
    const open = findUnclosedBlock(template);
    if (!open) return null;
    return {
      severity: "error",
      message: `O bloco {{#${open.name}}} não foi fechado. Feche com {{/${open.name}}}.`,
      line: open.line,
      column: open.column,
    };
  },
];

function syntaxProblem(template: string, error: ParseFailure): TemplateProblem {
  for (const rule of SYNTAX_RULES) {
    const problem = rule(template, error);
    if (problem) return problem;
  }
  const line = Number(RE_PARSE_LINE.exec(error.message)?.[1] ?? error.lineNumber ?? 1);
  return {
    severity: "error",
    message: "O modelo tem um erro de escrita nesta linha. Confira as chaves {{ }}.",
    line,
    column: 1,
  };
}

// ── Entrada ──────────────────────────────────────────────────────────────────────────────────

const byPosition = (a: TemplateProblem, b: TemplateProblem) =>
  a.line - b.line || a.column - b.column;

export function lintTemplate(template: string, options: LintTemplateOptions): TemplateProblem[] {
  let program: Program;
  try {
    program = Handlebars.parse(template);
  } catch (error) {
    return [syntaxProblem(template, error as ParseFailure)];
  }
  const root = rootSample(options.data);
  const walk: Walk = { options, problems: [] };
  visitProgram(walk, program, { root, frames: [root], params: new Map() });
  return walk.problems.sort(byPosition);
}
