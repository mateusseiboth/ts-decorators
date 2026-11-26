import { describe, expect, test } from "bun:test";

import { lintTemplate } from "../src/studio/lint";

const HELPERS = new Set([
  "each",
  "if",
  "unless",
  "with",
  "lookup",
  "sum",
  "currency",
  "dateNow",
  "ifCond",
  "groupBy",
]);
const PARTIALS = new Set(["assinaturas"]);

const DATA = {
  titulo: "Relatório",
  pessoa: { nome: "Ana", endereco: null },
  itens: [{ nome: "A", valor: 1, tags: [{ rotulo: "x" }] }],
  vazia: [],
};

const lint = (template: string, data: unknown = DATA) =>
  lintTemplate(template, { data, helpers: HELPERS, partials: PARTIALS });

describe("lintTemplate", () => {
  test("template válido não tem problemas", () => {
    expect(
      lint('<h1>{{titulo}}</h1>{{pessoa.nome}}{{currency (sum itens "valor")}}{{dateNow}}'),
    ).toEqual([]);
  });

  test("erro de sintaxe vira problema com linha, em português", () => {
    const [problem] = lint("<p>\n{{#each itens}}\n");
    expect(problem).toMatchObject({ severity: "error", line: 2 });
    expect(problem!.message).toContain("não foi fechado");
  });

  test("erro do lexer (chaves a mais) também aponta a linha certa", () => {
    const [problem] = lint("a\nb\n  {{{{@root.titulo}}}}\nc");
    expect(problem).toMatchObject({ severity: "error", line: 3 });
  });

  test("bloco fechado com o nome errado aponta a linha e os dois nomes", () => {
    const [problem] = lint("a\n\n  {{#if titulo}}b{{/each}}");
    expect(problem).toMatchObject({ severity: "error", line: 3 });
    expect(problem!.message).toContain("{{#if}}");
    expect(problem!.message).toContain("{{/each}}");
  });

  test("campo inexistente nos dados vira aviso na posição do campo", () => {
    expect(lint("x\n  {{titlo}}")).toEqual([
      {
        severity: "warning",
        message: "O campo titlo não existe nos dados carregados.",
        line: 2,
        column: 5,
      },
    ]);
  });

  test("dentro do each o contexto é o item da lista", () => {
    expect(lint("{{#each itens}}{{nome}}{{this.valor}}{{../titulo}}{{@index}}{{/each}}")).toEqual(
      [],
    );
    expect(lint("{{#each itens}}{{titulo}}{{/each}}")).toHaveLength(1);
  });

  test("each aninhado e block params", () => {
    expect(
      lint(
        "{{#each itens as |item i|}}{{item.nome}}{{#each item.tags}}{{rotulo}}{{/each}}{{/each}}",
      ),
    ).toEqual([]);
    expect(lint("{{#each itens as |item|}}{{item.nada}}{{/each}}")[0]!.message).toContain(
      "item.nada",
    );
  });

  test("with troca o contexto; if mantém", () => {
    expect(
      lint(
        "{{#with pessoa}}{{nome}}{{/with}}{{#if titulo}}{{titulo}}{{else}}{{pessoa.nome}}{{/if}}",
      ),
    ).toEqual([]);
  });

  test("lista vazia ou valor nulo não geram falso positivo", () => {
    expect(lint("{{#each vazia}}{{qualquer}}{{/each}}{{pessoa.endereco.rua}}")).toEqual([]);
  });

  test("sem dados carregados não acusa campo", () => {
    expect(lint("{{qualquer.coisa}}", {})).toEqual([]);
  });

  test("@root resolve a partir da raiz", () => {
    expect(lint("{{#each itens}}{{@root.titulo}}{{@root.nada}}{{/each}}")).toHaveLength(1);
  });

  test("função desconhecida é erro", () => {
    const [problem] = lint('{{moeda (sum itens "valor")}}');
    expect(problem).toMatchObject({ severity: "error", line: 1, column: 3 });
    expect(problem!.message).toBe("A função moeda não existe.");
  });

  test("subexpressão com função desconhecida também é erro", () => {
    expect(lint('{{currency (soma itens "valor")}}')[0]!.message).toBe("A função soma não existe.");
  });

  test("bloco com parâmetro e nome desconhecido é erro", () => {
    expect(lint("{{#se titulo}}x{{/se}}")[0]!.message).toBe("A função se não existe.");
  });

  test("each sem lista é erro", () => {
    expect(lint("{{#each}}x{{/each}}")[0]).toMatchObject({
      severity: "error",
      message: "Informe a lista do {{#each}}.",
    });
  });

  test("bloco reutilizável inexistente é aviso", () => {
    expect(lint("{{> assinaturas}}")).toEqual([]);
    expect(lint("{{> rodape}}")[0]).toMatchObject({
      severity: "warning",
      message: "O bloco {{> rodape}} não existe.",
    });
  });

  test("groupBy expõe key, items e count do grupo", () => {
    expect(
      lint(
        '{{#groupBy itens "nome"}}{{key}}{{count}}{{#each items}}{{valor}}{{/each}}{{/groupBy}}',
      ),
    ).toEqual([]);
    expect(lint('{{#groupBy itens "nome"}}{{nada}}{{/groupBy}}')).toHaveLength(1);
  });

  test("problemas saem na ordem do texto", () => {
    const problems = lint("{{b1}}\n{{a2}}\n{{#each itens}}{{c3}}{{/each}}");
    expect(problems.map((p) => p.line)).toEqual([1, 2, 3]);
  });
});
