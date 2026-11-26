/**
 * Helpers Handlebars default dos relatórios — fonte ÚNICA usada pelo worker de
 * PDF (produção) e pelo Studio (preview). Todo helper novo deve nascer aqui:
 * registrar em um lado só faria o template exportado quebrar no outro.
 *
 * REPORT_HELPER_DOCS alimenta o menu "Inserir função" do Studio — mantenha a
 * documentação junto do helper para o editor visual ficar sempre em dia.
 */
import type HandlebarsNS from "handlebars";

import { formatExtenso } from "./extenso";

type HandlebarsEnv = typeof HandlebarsNS;

/**
 * Texto de um valor arbitrário do relatório. Objeto continua virando
 * "[object Object]" — é o que os templates em produção já imprimem hoje; trocar
 * por JSON mudaria a saída. O cast é só para o lint: `String` faz exatamente isso.
 */
const toText = (value: unknown): string => String((value ?? "") as string);

/** Resolve caminho com pontos ("item.valor") dentro de um objeto, sem quebrar em null. */
function resolvePath(target: unknown, path: string): unknown {
  if (target == null || !path) return target;
  return String(path)
    .split(".")
    .reduce<unknown>(
      (acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]),
      target,
    );
}

/** Extrai os números de um array, opcionalmente lendo um campo de cada item. */
function numbersFrom(list: unknown, field?: unknown): number[] {
  if (!Array.isArray(list)) return [];
  const path = typeof field === "string" ? field : "";
  return list
    .map((item) => Number(path ? resolvePath(item, path) : item))
    .filter((value) => Number.isFinite(value));
}

function compare(a: unknown, operator: string, b: unknown): boolean {
  switch (operator) {
    case "==":
      // eslint-disable-next-line eqeqeq
      return a == b;
    case "!=":
      // eslint-disable-next-line eqeqeq
      return a != b;
    case ">":
      return Number(a) > Number(b);
    case ">=":
      return Number(a) >= Number(b);
    case "<":
      return Number(a) < Number(b);
    case "<=":
      return Number(a) <= Number(b);
    case "contem":
      return toText(a).toLowerCase().includes(toText(b).toLowerCase());
    case "vazio":
      return a == null || a === "" || (Array.isArray(a) && a.length === 0);
    case "preenchido":
      return !(a == null || a === "" || (Array.isArray(a) && a.length === 0));
    default:
      throw new Error(`Operador desconhecido em ifCond: "${operator}"`);
  }
}

/** Máscara por quantidade de dígitos: 11 é CPF, 14 é CNPJ. */
const MASCARAS_DOCUMENTO: Readonly<Record<number, readonly [RegExp, string]>> = {
  11: [/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4"],
  14: [/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5"],
};

/** CPF ou CNPJ com máscara. O que não for nenhum dos dois sai como veio. */
function formatCpfCnpj(value: unknown): string {
  const texto = toText(value);
  const digitos = texto.replace(/\D/g, "");
  const mascara = MASCARAS_DOCUMENTO[digitos.length];
  return mascara ? digitos.replace(mascara[0], mascara[1]) : texto;
}

interface GrupoDaLista {
  key: unknown;
  items: unknown[];
  count: number;
}

/** Agrupa pelo valor no caminho, na ordem em que cada valor aparece pela primeira vez. */
function groupItems(list: readonly unknown[], path: string): GrupoDaLista[] {
  const grupos = new Map<unknown, unknown[]>();
  for (const item of list) {
    const key = resolvePath(item, path);
    const items = grupos.get(key) ?? [];
    items.push(item);
    grupos.set(key, items);
  }
  return [...grupos].map(([key, items]) => ({ key, items, count: items.length }));
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function registerDefaultReportHelpers(hbs: HandlebarsEnv): void {
  hbs.registerHelper("currency", (value: unknown) =>
    Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
  );

  hbs.registerHelper("dateNow", () =>
    new Date().toLocaleString("pt-BR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  );

  hbs.registerHelper("formatDate", (value: unknown) => {
    const date = toDate(value);
    return date ? date.toLocaleDateString("pt-BR") : "";
  });

  hbs.registerHelper("formatDateTime", (value: unknown) => {
    const date = toDate(value);
    return date
      ? date.toLocaleString("pt-BR", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "";
  });

  hbs.registerHelper("number", (value: unknown, ...args: unknown[]) => {
    const decimals = typeof args[0] === "number" ? args[0] : 2;
    return Number(value || 0).toLocaleString("pt-BR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  });

  hbs.registerHelper(
    "percent",
    (value: unknown) =>
      `${Number(value || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`,
  );

  hbs.registerHelper("sum", (list: unknown, field?: unknown) =>
    numbersFrom(list, field).reduce((total, value) => total + value, 0),
  );

  hbs.registerHelper("avg", (list: unknown, field?: unknown) => {
    const numbers = numbersFrom(list, field);
    if (!numbers.length) return 0;
    return numbers.reduce((total, value) => total + value, 0) / numbers.length;
  });

  hbs.registerHelper("min", (list: unknown, field?: unknown) => {
    const numbers = numbersFrom(list, field);
    return numbers.length ? Math.min(...numbers) : 0;
  });

  hbs.registerHelper("max", (list: unknown, field?: unknown) => {
    const numbers = numbersFrom(list, field);
    return numbers.length ? Math.max(...numbers) : 0;
  });

  // `{{count}}` sem lista lê o campo count do contexto: é o total do grupo dentro do groupBy,
  // que o helper esconderia (helper vence campo de mesmo nome no Handlebars).
  hbs.registerHelper("count", function (this: unknown, ...args: unknown[]) {
    if (args.length === 1) return resolvePath(this, "count") ?? 0;
    return Array.isArray(args[0]) ? args[0].length : 0;
  });

  hbs.registerHelper("math", (a: unknown, operator: unknown, b: unknown) => {
    const left = Number(a) || 0;
    const right = Number(b) || 0;
    switch (String(operator)) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return right === 0 ? 0 : left / right;
      case "%":
        return right === 0 ? 0 : left % right;
      default:
        throw new Error(`Operador desconhecido em math: "${String(operator)}"`);
    }
  });

  hbs.registerHelper("ifCond", function (this: unknown, ...args: unknown[]) {
    const options = args[args.length - 1] as HandlebarsNS.HelperOptions;
    const [a, operator, b] = args;
    return compare(a, String(operator), b) ? options.fn(this) : options.inverse(this);
  });

  hbs.registerHelper("uppercase", (value: unknown) => toText(value).toUpperCase());
  hbs.registerHelper("lowercase", (value: unknown) => toText(value).toLowerCase());
  hbs.registerHelper("coalesce", (...args: unknown[]) => {
    const values = args.slice(0, -1);
    return values.find((value) => value != null && value !== "") ?? "";
  });
  hbs.registerHelper("index1", (index: unknown) => Number(index) + 1);

  hbs.registerHelper("formatCpfCnpj", (value: unknown) => formatCpfCnpj(value));

  hbs.registerHelper("extenso", (value: unknown) =>
    value == null || value === "" ? "" : formatExtenso(Number(value)),
  );

  hbs.registerHelper("groupBy", function (this: unknown, ...args: unknown[]) {
    const options = args[args.length - 1] as HandlebarsNS.HelperOptions;
    const [list, path] = args;
    const grupos = Array.isArray(list)
      ? groupItems(list, typeof path === "string" ? path : "")
      : [];
    if (!grupos.length) return options.inverse(this);

    return grupos
      .map((grupo, index) => {
        const data = hbs.createFrame(options.data) as Record<string, unknown>;
        data.index = index;
        data.first = index === 0;
        data.last = index === grupos.length - 1;
        return options.fn(grupo, { data });
      })
      .join("");
  });
}

export interface ReportHelperDoc {
  /** Nome do helper como usado no template. */
  name: string;
  /** Descrição curta em pt-BR para o menu do Studio. */
  description: string;
  /** Snippet pronto para inserir no editor. */
  snippet: string;
  category: "formato" | "calculo" | "logica";
}

export const REPORT_HELPER_DOCS: ReportHelperDoc[] = [
  {
    name: "currency",
    description: "Formata como moeda (R$ 1.234,56)",
    snippet: "{{currency valor}}",
    category: "formato",
  },
  {
    name: "number",
    description: "Formata número com 2 casas (1.234,56)",
    snippet: "{{number valor}}",
    category: "formato",
  },
  {
    name: "percent",
    description: "Formata como percentual (12,34%)",
    snippet: "{{percent valor}}",
    category: "formato",
  },
  {
    name: "formatDate",
    description: "Formata data (18/07/2026)",
    snippet: "{{formatDate data}}",
    category: "formato",
  },
  {
    name: "formatDateTime",
    description: "Formata data e hora (18/07/2026 14:30)",
    snippet: "{{formatDateTime data}}",
    category: "formato",
  },
  {
    name: "dateNow",
    description: "Data e hora de agora",
    snippet: "{{dateNow}}",
    category: "formato",
  },
  {
    name: "uppercase",
    description: "Texto em MAIÚSCULAS",
    snippet: "{{uppercase texto}}",
    category: "formato",
  },
  {
    name: "lowercase",
    description: "Texto em minúsculas",
    snippet: "{{lowercase texto}}",
    category: "formato",
  },
  {
    name: "coalesce",
    description: "Primeiro valor preenchido (valor ou padrão)",
    snippet: '{{coalesce valor "—"}}',
    category: "formato",
  },
  {
    name: "sum",
    description: "Soma um campo numérico de uma lista",
    snippet: '{{sum itens "valor"}}',
    category: "calculo",
  },
  {
    name: "avg",
    description: "Média de um campo numérico de uma lista",
    snippet: '{{avg itens "valor"}}',
    category: "calculo",
  },
  {
    name: "min",
    description: "Menor valor de um campo da lista",
    snippet: '{{min itens "valor"}}',
    category: "calculo",
  },
  {
    name: "max",
    description: "Maior valor de um campo da lista",
    snippet: '{{max itens "valor"}}',
    category: "calculo",
  },
  {
    name: "count",
    description: "Quantidade de itens da lista",
    snippet: "{{count itens}}",
    category: "calculo",
  },
  {
    name: "math",
    description: "Conta simples entre dois valores (+ - * / %)",
    snippet: '{{math a "+" b}}',
    category: "calculo",
  },
  {
    name: "index1",
    description: "Número da linha começando em 1 (dentro de each)",
    snippet: "{{index1 @index}}",
    category: "calculo",
  },
  {
    name: "formatCpfCnpj",
    description: "CPF ou CNPJ com máscara (123.456.789-01)",
    snippet: "{{formatCpfCnpj documento}}",
    category: "formato",
  },
  {
    name: "extenso",
    description: "Valor em reais por extenso (cento e um reais)",
    snippet: "{{extenso valor}}",
    category: "formato",
  },
  {
    name: "groupBy",
    description: "Repete o conteúdo para cada grupo da lista (key, items e count)",
    snippet: '{{#groupBy itens "categoria"}}{{key}}: {{count}}{{else}}Sem itens{{/groupBy}}',
    category: "logica",
  },
  {
    name: "ifCond",
    description: "Mostra o conteúdo só se a condição for verdadeira",
    snippet: '{{#ifCond status "==" "ATIVO"}}Ativo{{else}}Inativo{{/ifCond}}',
    category: "logica",
  },
];
