import { describe, expect, test } from "bun:test";

import { suggest } from "../src/studio/client/logic/completion";
import { buildFieldInsertion, listExprAt, readFrames } from "../src/studio/client/logic/context";
import { collectLists, describeData } from "../src/studio/client/logic/dataSchema";
import { highlightTemplate } from "../src/studio/client/logic/highlight";
import {
  buildCalc,
  buildCondition,
  buildGroup,
  buildTable,
} from "../src/studio/client/logic/snippets";

const DATA = {
  titulo: "Relatório",
  emissao: "2026-11-05",
  pessoa: { nome: "Ana" },
  itens: [{ nome: "A", valor: 1.5, tags: [{ rotulo: "x" }] }],
};
const SCHEMA = describeData(DATA);
const HELPERS = [
  { name: "currency", description: "Moeda", snippet: "{{currency valor}}", category: "formato" },
  {
    name: "ifCond",
    description: "Se",
    snippet: '{{#ifCond a "==" b}}{{/ifCond}}',
    category: "logica",
  },
  {
    name: "groupBy",
    description: "Agrupa",
    snippet: '{{#groupBy itens "c"}}{{/groupBy}}',
    category: "logica",
  },
];

describe("describeData", () => {
  test("monta a árvore com tipo, amostra e caminho com marcador de lista", () => {
    const [titulo, emissao, pessoa, itens] = SCHEMA;
    expect(titulo).toMatchObject({
      key: "titulo",
      kind: "texto",
      path: ["titulo"],
      sample: "Relatório",
    });
    expect(emissao!.kind).toBe("data");
    expect(pessoa!.children[0]!.path).toEqual(["pessoa", "nome"]);
    expect(itens).toMatchObject({ kind: "lista", sample: "1 item" });
    expect(itens!.children.map((c) => c.path)).toEqual([
      ["itens", "[]", "nome"],
      ["itens", "[]", "valor"],
      ["itens", "[]", "tags"],
    ]);
  });

  test("collectLists lista as listas com os campos do item", () => {
    expect(collectLists(SCHEMA)).toEqual([
      {
        path: ["itens"],
        label: "itens",
        fields: [
          { name: "nome", kind: "texto" },
          { name: "valor", kind: "numero" },
          { name: "tags", kind: "lista" },
        ],
      },
      {
        path: ["itens", "[]", "tags"],
        label: "tags",
        fields: [{ name: "rotulo", kind: "texto" }],
      },
    ]);
  });
});

describe("contexto do cursor", () => {
  test("readFrames acompanha each, with e groupBy abertos", () => {
    const frames = readFrames("{{#each itens}}{{#each tags}}{{/each}}{{#with ../pessoa}}");
    expect(frames.map((f) => f.abs)).toEqual([[], ["itens", "[]"], ["pessoa"]]);
    expect(readFrames('{{#groupBy itens "x"}}{{#each items}}').map((f) => f.abs)).toEqual([
      [],
      ["itens", "{}"],
      ["itens", "[]"],
    ]);
    expect(readFrames("{{#if x}}{{#each itens}}{{/each}}{{/if}}")).toHaveLength(1);
  });

  test("campo do item dentro do each sai relativo", () => {
    expect(buildFieldInsertion(["itens", "[]", "nome"], "{{#each itens}}")).toBe("{{nome}}");
  });

  test("campo do item fora do each vem embrulhado no each", () => {
    expect(buildFieldInsertion(["itens", "[]", "nome"], "")).toBe(
      "{{#each itens}}{{nome}}{{/each}}",
    );
    expect(buildFieldInsertion(["itens", "[]", "tags", "[]", "rotulo"], "{{#each itens}}")).toBe(
      "{{#each tags}}{{rotulo}}{{/each}}",
    );
  });

  test("campo da raiz dentro de um each usa @root", () => {
    expect(buildFieldInsertion(["titulo"], "{{#each itens}}")).toBe("{{@root.titulo}}");
    expect(buildFieldInsertion(["pessoa", "nome"], "<p>")).toBe("{{pessoa.nome}}");
  });

  test("listExprAt devolve a lista relativa ao cursor, ou null se ela não é alcançável", () => {
    expect(listExprAt(["itens"], "")).toBe("itens");
    expect(listExprAt(["itens", "[]", "tags"], "{{#each itens}}")).toBe("tags");
    expect(listExprAt(["itens", "[]", "tags"], "")).toBeNull();
    expect(listExprAt(["itens"], "{{#each itens}}")).toBe("@root.itens");
  });

  test("com o cursor dentro de {{ }} entra só a expressão", () => {
    expect(buildFieldInsertion(["titulo"], "{{#each itens}}{{currency ")).toBe("@root.titulo");
    expect(buildFieldInsertion(["itens", "[]", "valor"], "{{#each itens}}{{")).toBe("valor");
  });

  test("bloco já fechado não conta", () => {
    expect(buildFieldInsertion(["titulo"], "{{#each itens}}x{{/each}}")).toBe("{{titulo}}");
  });
});

describe("autocompletar", () => {
  const ctx = { schema: SCHEMA, helpers: HELPERS };
  const labels = (text: string) =>
    suggest(text, text.length, ctx)?.items.map((i) => i.label) ?? null;

  test("fora de {{ não sugere nada", () => {
    expect(suggest("<p>titulo", 9, ctx)).toBeNull();
    expect(suggest("{{titulo}} ti", 13, ctx)).toBeNull();
  });

  test("sugere campos e funções filtrando pelo que foi digitado", () => {
    expect(labels("{{ti")).toEqual(["titulo"]);
    expect(labels("{{cur")).toEqual(["currency"]);
    expect(labels("{{pe")).toContain("pessoa.nome");
  });

  test("campo como primeiro termo fecha as chaves", () => {
    const result = suggest("{{tit", 5, ctx)!;
    expect(result).toMatchObject({ from: 2, to: 5 });
    expect(result.items[0]!.insert).toBe("titulo}}");
  });

  test("dentro do each sugere os campos do item e as variáveis do laço", () => {
    const items = labels("{{#each itens}}{{");
    expect(items).toContain("nome");
    expect(items).toContain("@index");
    expect(items).not.toContain("titulo");
  });

  test("{{# sugere os blocos e {{/ fecha o bloco aberto", () => {
    expect(labels("{{#")).toEqual(
      expect.arrayContaining(["each", "if", "with", "ifCond", "groupBy"]),
    );
    const close = suggest("{{#each itens}}x{{/", 19, ctx)!;
    expect(close.items).toEqual([
      { label: "each", insert: "each}}", detail: "Fecha o {{#each itens}}", kind: "fechar" },
    ]);
  });

  test("parâmetro sugere só campos; após ( volta a sugerir funções", () => {
    expect(labels("{{currency ")).not.toContain("currency");
    expect(labels("{{currency (cur")).toEqual(["currency"]);
    expect(suggest("{{currency val", 14, ctx)).toMatchObject({ items: [] });
  });
});

describe("assistentes", () => {
  test("tabela com formato por coluna, numeração e total", () => {
    const html = buildTable({
      listExpr: "itens",
      columns: [
        { field: "nome", label: "Nome", format: "texto" },
        { field: "valor", label: "Valor", format: "moeda" },
      ],
      withIndex: true,
      withTotals: true,
    });
    expect(html).toContain("{{#each itens}}");
    expect(html).toContain("{{index1 @index}}");
    expect(html).toContain("{{currency valor}}");
    expect(html).toContain('{{currency (sum itens "valor")}}');
    expect(html).toContain(">Nome<");
  });

  test("condicional com texto, número e operador sem valor", () => {
    expect(buildCondition({ field: "status", operator: "==", value: 'A"B', withElse: true })).toBe(
      '{{#ifCond status "==" "A\\"B"}}\n  \n{{else}}\n  \n{{/ifCond}}',
    );
    expect(buildCondition({ field: "total", operator: ">", value: "100", withElse: false })).toBe(
      '{{#ifCond total ">" 100}}\n  \n{{/ifCond}}',
    );
    expect(buildCondition({ field: "obs", operator: "vazio", value: "", withElse: false })).toBe(
      '{{#ifCond obs "vazio"}}\n  \n{{/ifCond}}',
    );
  });

  test("cálculo", () => {
    expect(
      buildCalc({ operation: "sum", listExpr: "itens", field: "valor", format: "moeda" }),
    ).toBe('{{currency (sum itens "valor")}}');
    expect(buildCalc({ operation: "count", listExpr: "itens", field: "", format: "numero" })).toBe(
      "{{count itens}}",
    );
  });

  test("agrupamento com subtotal", () => {
    const html = buildGroup({
      listExpr: "itens",
      groupField: "categoria",
      columns: [{ field: "nome", label: "Nome", format: "texto" }],
      sumField: "valor",
    });
    expect(html).toContain('{{#groupBy itens "categoria"}}');
    expect(html).toContain("{{key}}");
    expect(html).toContain("{{#each items}}");
    expect(html).toContain("{{nome}}");
    expect(html).toContain('{{currency (sum items "valor")}}');
    expect(html).toContain("{{/groupBy}}");
  });
});

describe("realce de sintaxe", () => {
  test("escapa HTML e marca tags, atributos, mustaches e comentários", () => {
    const out = highlightTemplate('<p class="a">{{nome}}{{#each x}}{{!-- nota --}}</p>');
    expect(out).toContain('<span class="tok-tag">p</span>');
    expect(out).toContain('<span class="tok-attr">class</span>');
    expect(out).toContain('<span class="tok-hbs">{{nome}}</span>');
    expect(out).toContain('<span class="tok-hbs-block">{{#each x}}</span>');
    expect(out).toContain('<span class="tok-com">{{!-- nota --}}</span>');
    expect(highlightTemplate("a < b & c")).toBe("a &lt; b &amp; c");
  });
});
