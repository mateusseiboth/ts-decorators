import { describe, expect, test } from "bun:test";

import Handlebars from "handlebars";

import { formatExtenso } from "../src/report/extenso";
import { REPORT_HELPER_DOCS, registerDefaultReportHelpers } from "../src/report/templateHelpers";

function compile(template: string, data: unknown = {}): string {
  const hbs = Handlebars.create();
  registerDefaultReportHelpers(hbs);
  return hbs.compile(template)(data);
}

const itens = [
  { nome: "A", valor: 10.5, quantidade: 2 },
  { nome: "B", valor: 4.5, quantidade: 1 },
  { nome: "C", valor: 5, quantidade: 3 },
];

describe("templateHelpers — formatação", () => {
  test("currency formata em BRL", () => {
    expect(compile("{{currency 1234.5}}")).toContain("1.234,50");
  });

  test("number formata com 2 casas pt-BR", () => {
    expect(compile("{{number 1234.5}}")).toBe("1.234,50");
  });

  test("percent formata com sufixo %", () => {
    expect(compile("{{percent 12.3}}")).toBe("12,30%");
  });

  test("formatDate/formatDateTime aceitam ISO e ignoram inválidos", () => {
    expect(compile("{{formatDate d}}", { d: "2026-07-18T12:00:00Z" })).toContain("2026");
    expect(compile("{{formatDate d}}", { d: "nada" })).toBe("");
    expect(compile("{{formatDateTime d}}", { d: "2026-07-18T12:00:00Z" })).toContain("2026");
  });

  test("uppercase/lowercase/coalesce", () => {
    expect(compile("{{uppercase 'abc'}}")).toBe("ABC");
    expect(compile("{{lowercase 'ABC'}}")).toBe("abc");
    expect(compile("{{coalesce vazio 'padrão'}}", { vazio: "" })).toBe("padrão");
    expect(compile("{{coalesce nome 'padrão'}}", { nome: "X" })).toBe("X");
  });
});

describe("templateHelpers — cálculo", () => {
  test("sum soma um campo da lista", () => {
    expect(compile('{{sum itens "valor"}}', { itens })).toBe("20");
  });

  test("sum funciona em subexpressão com currency (uso do assistente)", () => {
    expect(compile('{{currency (sum itens "valor")}}', { itens })).toContain("20,00");
  });

  test("avg/min/max/count", () => {
    expect(compile('{{avg itens "quantidade"}}', { itens })).toBe("2");
    expect(compile('{{min itens "valor"}}', { itens })).toBe("4.5");
    expect(compile('{{max itens "valor"}}', { itens })).toBe("10.5");
    expect(compile("{{count itens}}", { itens })).toBe("3");
  });

  test("agregações toleram lista vazia/ausente e valores não numéricos", () => {
    expect(compile('{{sum itens "valor"}}', {})).toBe("0");
    expect(compile('{{avg itens "valor"}}', { itens: [] })).toBe("0");
    expect(compile('{{sum itens "valor"}}', { itens: [{ valor: "x" }, { valor: 2 }] })).toBe("2");
  });

  test("sum resolve caminho aninhado com ponto", () => {
    const data = { itens: [{ sub: { valor: 1 } }, { sub: { valor: 2 } }] };
    expect(compile('{{sum itens "sub.valor"}}', data)).toBe("3");
  });

  test("math aplica as operações básicas e não divide por zero", () => {
    expect(compile('{{math 10 "+" 5}}')).toBe("15");
    expect(compile('{{math 10 "/" 0}}')).toBe("0");
  });

  test("count sem lista lê o campo count do contexto", () => {
    expect(compile("{{count}}", { count: 7 })).toBe("7");
    expect(compile("{{count}}", {})).toBe("0");
    expect(compile("{{count ausente}}", { count: 7 })).toBe("0");
  });

  test("index1 converte @index para base 1", () => {
    expect(compile("{{#each itens}}{{index1 @index}}{{/each}}", { itens })).toBe("123");
  });
});

describe("templateHelpers — lógica (ifCond)", () => {
  test("comparações básicas com else", () => {
    const tpl = '{{#ifCond status "==" "ATIVO"}}sim{{else}}não{{/ifCond}}';
    expect(compile(tpl, { status: "ATIVO" })).toBe("sim");
    expect(compile(tpl, { status: "X" })).toBe("não");
    expect(compile('{{#ifCond n ">" 5}}maior{{/ifCond}}', { n: 9 })).toBe("maior");
  });

  test("operadores contem/vazio/preenchido", () => {
    expect(compile('{{#ifCond nome "contem" "qual"}}ok{{/ifCond}}', { nome: "Qualidade" })).toBe(
      "ok",
    );
    expect(compile('{{#ifCond lista "vazio"}}vazia{{/ifCond}}', { lista: [] })).toBe("vazia");
    expect(compile('{{#ifCond nome "preenchido"}}tem{{/ifCond}}', { nome: "x" })).toBe("tem");
  });

  test("operador desconhecido falha com mensagem clara", () => {
    expect(() => compile('{{#ifCond a "~~" b}}x{{/ifCond}}', { a: 1, b: 2 })).toThrow(
      /Operador desconhecido/,
    );
  });
});

describe("templateHelpers — formatCpfCnpj", () => {
  test("formata CPF com 11 dígitos", () => {
    expect(compile("{{formatCpfCnpj doc}}", { doc: "12345678901" })).toBe("123.456.789-01");
  });

  test("formata CNPJ com 14 dígitos, ignorando a máscara de origem", () => {
    expect(compile("{{formatCpfCnpj doc}}", { doc: "12.345.678/0001-90" })).toBe(
      "12.345.678/0001-90",
    );
    expect(compile("{{formatCpfCnpj doc}}", { doc: "12345678000190" })).toBe("12.345.678/0001-90");
  });

  test("aceita número", () => {
    expect(compile("{{formatCpfCnpj doc}}", { doc: 12345678901 })).toBe("123.456.789-01");
  });

  test("devolve o valor original quando não é CPF nem CNPJ", () => {
    expect(compile("{{formatCpfCnpj doc}}", { doc: "123-45" })).toBe("123-45");
    expect(compile("{{formatCpfCnpj doc}}", { doc: null })).toBe("");
    expect(compile("{{formatCpfCnpj doc}}", {})).toBe("");
  });
});

describe("templateHelpers — extenso", () => {
  const casos: readonly (readonly [number, string])[] = [
    [0, "zero real"],
    [1, "um real"],
    [2, "dois reais"],
    [0.5, "cinquenta centavos"],
    [0.01, "um centavo"],
    [1.01, "um real e um centavo"],
    [21, "vinte e um reais"],
    [100, "cem reais"],
    [101, "cento e um reais"],
    [150.5, "cento e cinquenta reais e cinquenta centavos"],
    [1000, "mil reais"],
    [1001, "mil e um reais"],
    [1100, "mil e cem reais"],
    [1234, "mil duzentos e trinta e quatro reais"],
    [2000, "dois mil reais"],
    [1000000, "um milhão de reais"],
    [2500000, "dois milhões e quinhentos mil reais"],
    [1000001, "um milhão e um reais"],
    [3000000000, "três bilhões de reais"],
    [
      1234567.89,
      "um milhão duzentos e trinta e quatro mil quinhentos e sessenta e sete reais e oitenta e nove centavos",
    ],
    [-2, "menos dois reais"],
    [1.999, "dois reais"],
  ];

  for (const [valor, esperado] of casos) {
    test(`${valor} vira "${esperado}"`, () => {
      expect(formatExtenso(valor)).toBe(esperado);
    });
  }

  test("o helper escreve o valor por extenso e aceita texto numérico", () => {
    expect(compile("{{extenso valor}}", { valor: 150.5 })).toBe(
      "cento e cinquenta reais e cinquenta centavos",
    );
    expect(compile("{{extenso valor}}", { valor: "2" })).toBe("dois reais");
  });

  test("acima da casa dos bilhões vira texto vazio", () => {
    expect(formatExtenso(1e12)).toBe("");
    expect(formatExtenso(999999999999.999)).toBe("");
  });

  test("valor não numérico vira texto vazio", () => {
    expect(compile("{{extenso valor}}", { valor: "abc" })).toBe("");
    expect(compile("{{extenso valor}}", {})).toBe("");
    expect(compile("{{extenso valor}}", { valor: null })).toBe("");
  });
});

describe("templateHelpers — groupBy", () => {
  const vendas = [
    { categoria: "B", nome: "b1", info: { setor: "X" } },
    { categoria: "A", nome: "a1", info: { setor: "Y" } },
    { categoria: "B", nome: "b2", info: { setor: "X" } },
  ];

  test("agrupa na ordem da primeira aparição com key, items e count", () => {
    const tpl =
      '{{#groupBy vendas "categoria"}}[{{key}}:{{count}}:{{#each items}}{{nome}}{{/each}}]{{/groupBy}}';
    expect(compile(tpl, { vendas })).toBe("[B:2:b1b2][A:1:a1]");
  });

  test("resolve caminho com ponto", () => {
    expect(
      compile('{{#groupBy vendas "info.setor"}}{{key}}={{count}};{{/groupBy}}', { vendas }),
    ).toBe("X=2;Y=1;");
  });

  test("expõe @index, @first e @last", () => {
    const tpl =
      '{{#groupBy vendas "categoria"}}{{@index}}{{#if @first}}f{{/if}}{{#if @last}}l{{/if}};{{/groupBy}}';
    expect(compile(tpl, { vendas })).toBe("0f;1l;");
  });

  test("lista vazia ou ausente cai no else", () => {
    const tpl = '{{#groupBy vendas "categoria"}}{{key}}{{else}}sem dados{{/groupBy}}';
    expect(compile(tpl, { vendas: [] })).toBe("sem dados");
    expect(compile(tpl, {})).toBe("sem dados");
    expect(compile(tpl, { vendas: "x" })).toBe("sem dados");
  });
});

describe("templateHelpers — catálogo do Studio", () => {
  test("todo helper documentado está registrado e o snippet compila", () => {
    const hbs = Handlebars.create();
    registerDefaultReportHelpers(hbs);
    const data = {
      valor: 10,
      data: "2026-07-18",
      texto: "abc",
      status: "ATIVO",
      a: 1,
      b: 2,
      itens,
      documento: "12345678901",
    };
    for (const doc of REPORT_HELPER_DOCS) {
      expect((hbs as any).helpers[doc.name]).toBeDefined();
      // Snippets do menu não podem quebrar quando inseridos num template.
      expect(() => hbs.compile(doc.snippet)(data)).not.toThrow();
    }
  });
});
