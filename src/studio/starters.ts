/**
 * Modelos prontos da galeria "Novo" do Studio. Cada um traz dados de exemplo para a prévia já
 * abrir preenchida; `studio.starters.test.ts` garante que todo modelo renderiza e passa no lint
 * contra os próprios dados.
 */
export interface StudioStarter {
  id: string;
  name: string;
  description: string;
  template: string;
  sampleData: Record<string, unknown>;
}

const PAGINA = "font-family: Arial, sans-serif; font-size: 12px; color: #222; padding: 24px;";
const TH = "border-bottom: 2px solid #333; padding: 6px 8px; text-align: left;";
const TD = "border-bottom: 1px solid #ddd; padding: 6px 8px;";

const ITENS = [
  { codigo: "001", descricao: "Papel A4", categoria: "Material", quantidade: 10, valor: 32.9 },
  { codigo: "002", descricao: "Toner", categoria: "Material", quantidade: 2, valor: 389.5 },
  { codigo: "003", descricao: "Manutenção", categoria: "Serviço", quantidade: 1, valor: 750 },
  { codigo: "004", descricao: "Limpeza", categoria: "Serviço", quantidade: 4, valor: 180 },
];

const CABECALHO = `  <div style="display: flex; justify-content: space-between; align-items: flex-end;">
    <div>
      <h1 style="margin: 0; font-size: 20px;">{{titulo}}</h1>
      <div style="color: #666;">{{orgao}}</div>
    </div>
    <small style="color: #666;">Emitido em {{dateNow}}</small>
  </div>
  <hr style="border: 0; border-top: 1px solid #999; margin: 12px 0;" />`;

const listagem: StudioStarter = {
  id: "listagem",
  name: "Listagem com totais",
  description: "Cabeçalho, tabela de itens e linha de total.",
  sampleData: { titulo: "Relação de compras", orgao: "Secretaria de Administração", itens: ITENS },
  template: `<div style="${PAGINA}">
${CABECALHO}
  <table style="width: 100%; border-collapse: collapse;">
    <thead>
      <tr>
        <th style="${TH}">Código</th>
        <th style="${TH}">Descrição</th>
        <th style="${TH} text-align: right;">Qtd.</th>
        <th style="${TH} text-align: right;">Valor</th>
      </tr>
    </thead>
    <tbody>
      {{#each itens}}
      <tr>
        <td style="${TD}">{{codigo}}</td>
        <td style="${TD}">{{descricao}}</td>
        <td style="${TD} text-align: right;">{{number quantidade 0}}</td>
        <td style="${TD} text-align: right;">{{currency valor}}</td>
      </tr>
      {{else}}
      <tr><td colspan="4" style="${TD} text-align: center;">Nenhum item.</td></tr>
      {{/each}}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3" style="${TD} font-weight: bold;">Total ({{count itens}} itens)</td>
        <td style="${TD} text-align: right; font-weight: bold;">{{currency (sum itens "valor")}}</td>
      </tr>
    </tfoot>
  </table>
</div>`,
};

const agrupado: StudioStarter = {
  id: "agrupado",
  name: "Agrupado com subtotais",
  description: "Uma seção por categoria, com subtotal e total geral.",
  sampleData: { titulo: "Despesas por categoria", orgao: "Secretaria de Finanças", itens: ITENS },
  template: `<div style="${PAGINA}">
${CABECALHO}
  {{#groupBy itens "categoria"}}
  <h3 style="margin: 16px 0 4px;">{{key}} <small style="color: #666;">({{count}} itens)</small></h3>
  <table style="width: 100%; border-collapse: collapse;">
    {{#each items}}
    <tr>
      <td style="${TD}">{{descricao}}</td>
      <td style="${TD} text-align: right; width: 120px;">{{currency valor}}</td>
    </tr>
    {{/each}}
    <tr>
      <td style="${TD} text-align: right; font-weight: bold;">Subtotal</td>
      <td style="${TD} text-align: right; font-weight: bold;">{{currency (sum items "valor")}}</td>
    </tr>
  </table>
  {{else}}
  <p>Nenhum item no período.</p>
  {{/groupBy}}
  <p style="text-align: right; font-size: 14px; margin-top: 16px;">
    <b>Total geral: {{currency (sum itens "valor")}}</b>
  </p>
</div>`,
};

const declaracao: StudioStarter = {
  id: "declaracao",
  name: "Declaração ou certidão",
  description: "Texto corrido com os dados da pessoa, valor por extenso e assinaturas.",
  sampleData: {
    titulo: "Declaração de quitação",
    orgao: "Prefeitura Municipal",
    contribuinte: { nome: "Maria da Silva", documento: "12345678909" },
    exercicio: 2026,
    valor: 1532.4,
    cidade: "Campo Grande",
  },
  template: `<div style="${PAGINA} font-size: 14px; line-height: 1.8;">
  <div style="text-align: center;">
    <div style="color: #666;">{{orgao}}</div>
    <h1 style="font-size: 20px; text-transform: uppercase;">{{titulo}}</h1>
  </div>
  <p style="text-align: justify; text-indent: 48px;">
    Declaramos, para os devidos fins, que <b>{{uppercase contribuinte.nome}}</b>, inscrito(a) sob o
    nº {{formatCpfCnpj contribuinte.documento}}, quitou os débitos do exercício de {{exercicio}},
    no valor de {{currency valor}} ({{extenso valor}}).
  </p>
  <p style="text-align: right; margin-top: 48px;">{{cidade}}, {{dateNow}}.</p>
  {{> assinaturas}}
</div>`,
};

const ficha: StudioStarter = {
  id: "ficha",
  name: "Ficha cadastral",
  description: "Os campos de um registro em pares de rótulo e valor.",
  sampleData: {
    titulo: "Ficha do imóvel",
    orgao: "Cadastro Imobiliário",
    imovel: {
      inscricao: "01.02.003.0004",
      endereco: "Rua das Flores, 120",
      area: 360,
      situacao: "ATIVO",
    },
    proprietario: { nome: "João Pereira", documento: "11222333000181" },
  },
  template: `<div style="${PAGINA}">
${CABECALHO}
  <table style="width: 100%; border-collapse: collapse;">
    <tr><td style="${TD} width: 30%; color: #666;">Inscrição</td><td style="${TD}">{{imovel.inscricao}}</td></tr>
    <tr><td style="${TD} color: #666;">Endereço</td><td style="${TD}">{{imovel.endereco}}</td></tr>
    <tr><td style="${TD} color: #666;">Área</td><td style="${TD}">{{number imovel.area}} m²</td></tr>
    <tr><td style="${TD} color: #666;">Proprietário</td><td style="${TD}">{{proprietario.nome}}</td></tr>
    <tr><td style="${TD} color: #666;">CPF/CNPJ</td><td style="${TD}">{{formatCpfCnpj proprietario.documento}}</td></tr>
    <tr>
      <td style="${TD} color: #666;">Situação</td>
      <td style="${TD}">
        {{#ifCond imovel.situacao "==" "ATIVO"}}<b style="color: #188038;">Ativo</b>{{else}}<b style="color: #d93025;">{{imovel.situacao}}</b>{{/ifCond}}
      </td>
    </tr>
  </table>
</div>`,
};

const emBranco: StudioStarter = {
  id: "em-branco",
  name: "Em branco",
  description: "Só a página, para começar do zero.",
  sampleData: { titulo: "Meu relatório" },
  template: `<div style="${PAGINA}">
  <h1 style="margin: 0;">{{titulo}}</h1>
</div>`,
};

export const STUDIO_STARTERS: readonly StudioStarter[] = [
  listagem,
  agrupado,
  declaracao,
  ficha,
  emBranco,
];
