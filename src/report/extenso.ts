/**
 * Valor em reais escrito por extenso ("cento e um reais e dez centavos"), até a casa dos
 * bilhões. Usado pelo helper `extenso` dos relatórios (recibos, promissórias, contratos).
 */

const UNIDADES = [
  "zero",
  "um",
  "dois",
  "três",
  "quatro",
  "cinco",
  "seis",
  "sete",
  "oito",
  "nove",
  "dez",
  "onze",
  "doze",
  "treze",
  "quatorze",
  "quinze",
  "dezesseis",
  "dezessete",
  "dezoito",
  "dezenove",
] as const;

const DEZENAS = [
  "",
  "",
  "vinte",
  "trinta",
  "quarenta",
  "cinquenta",
  "sessenta",
  "setenta",
  "oitenta",
  "noventa",
] as const;

const CENTENAS = [
  "",
  "cento",
  "duzentos",
  "trezentos",
  "quatrocentos",
  "quinhentos",
  "seiscentos",
  "setecentos",
  "oitocentos",
  "novecentos",
] as const;

interface Escala {
  valor: number;
  singular: string;
  plural: string;
}

const ESCALAS: readonly Escala[] = [
  { valor: 1e9, singular: "bilhão", plural: "bilhões" },
  { valor: 1e6, singular: "milhão", plural: "milhões" },
  { valor: 1e3, singular: "mil", plural: "mil" },
  { valor: 1, singular: "", plural: "" },
];

interface Grupo {
  escala: Escala;
  quantidade: number;
}

/** Primeiro valor que já não cabe nas escalas acima, em centavos. */
const LIMITE_EM_CENTAVOS = 1e14;

const joinWords = (words: readonly string[], separator: string): string =>
  words.filter(Boolean).join(separator);

/** 0 a 99. */
function writeDezenas(n: number): string {
  if (n < 20) return UNIDADES[n] ?? "";
  const unidade = n % 10;
  return joinWords(
    [DEZENAS[Math.floor(n / 10)] ?? "", unidade ? (UNIDADES[unidade] ?? "") : ""],
    " e ",
  );
}

/** 1 a 999. Cem exato é "cem"; de 101 em diante é "cento e ...". */
function writeCentenas(n: number): string {
  if (n === 100) return "cem";
  const resto = n % 100;
  return joinWords([CENTENAS[Math.floor(n / 100)] ?? "", resto ? writeDezenas(resto) : ""], " e ");
}

/** "mil" sozinho, sem "um" na frente; nas demais escalas o número vem antes do nome. */
function writeGrupo({ escala, quantidade }: Grupo): string {
  const isUm = quantidade === 1;
  const numero = isUm && escala.valor === 1e3 ? "" : writeCentenas(quantidade);
  return joinWords([numero, isUm ? escala.singular : escala.plural], " ");
}

/**
 * O último grupo leva "e" quando é menor que cem ou centena redonda: "mil e um",
 * "mil e cem", mas "mil duzentos e trinta e quatro".
 */
const isConectadoPorE = ({ quantidade }: Grupo): boolean =>
  quantidade < 100 || quantidade % 100 === 0;

function writeInteiro(n: number): string {
  const grupos = ESCALAS.map((escala) => ({
    escala,
    quantidade: Math.floor(n / escala.valor) % 1000,
  })).filter((grupo) => grupo.quantidade > 0);
  const ultimo = grupos.length - 1;
  return grupos
    .map((grupo, index) => {
      const texto = writeGrupo(grupo);
      const isLigado = index > 0 && index === ultimo && isConectadoPorE(grupo);
      return isLigado ? `e ${texto}` : texto;
    })
    .join(" ");
}

/** Milhão e bilhão redondos pedem "de": "um milhão de reais". */
function writeReais(inteiro: number): string {
  const de = inteiro % 1e6 === 0 ? "de " : "";
  return `${writeInteiro(inteiro)} ${de}${inteiro === 1 ? "real" : "reais"}`;
}

const writeCentavos = (centavos: number): string =>
  `${writeDezenas(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`;

/**
 * Escreve um valor em reais por extenso, arredondado aos centavos. Negativo leva "menos" na
 * frente. Valor não finito ou a partir de um trilhão devolve texto vazio.
 */
export function formatExtenso(value: number): string {
  if (!Number.isFinite(value)) return "";
  const totalCentavos = Math.round(Math.abs(value) * 100);
  if (totalCentavos >= LIMITE_EM_CENTAVOS) return "";
  if (totalCentavos === 0) return "zero real";

  const inteiro = Math.floor(totalCentavos / 100);
  const centavos = totalCentavos % 100;
  const texto = joinWords(
    [inteiro ? writeReais(inteiro) : "", centavos ? writeCentavos(centavos) : ""],
    " e ",
  );
  return value < 0 ? `menos ${texto}` : texto;
}
