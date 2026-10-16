# Tipos do `@Field` — referência completa

Tudo que `@Field(...)` aceita e o que o `@AutoConvert` faz com cada tipo. O tipo declarado aqui é
o mesmo que o `getWhere`, o `getOrderBy` e o `collectFieldTypes` enxergam.

```ts
@InitFields
class AgendaModel {
  @Field("string") id!: string;
  @Field("number") codigo!: number;
  @Field("zoneddatetime") inicio!: Temporal.ZonedDateTime;
  @Field(Temporal.PlainDate) competencia!: Temporal.PlainDate;
  @Field(LocalModel) local!: LocalModel;
  @Field([ParticipanteModel]) participantes!: ParticipanteModel[];
}
```

---

## 1. Primitivos

| Tipo | Entrada | Saída |
| --- | --- | --- |
| `"string"` | `42`, `true` | `"42"`, `"true"` |
| `"number"` | `"9.99"` | `9.99` |
| `"number"` | `"abc"` | `null` |
| `"bigint"` | `"123"` | `123n` |
| `"bigint"` | `"abc"` | `null` |
| `"boolean"` | `"true"`, `"1"`, `"S"`, `1` | `true` |
| `"boolean"` | `"false"`, `"0"`, `"N"`, `0` | `false` |
| `"boolean"` | qualquer outra coisa | `Boolean(val)` |
| `"date"` | `"2026-01-15"`, `"15/01/2026"`, epoch, RFC, `Date`, valor do Temporal | `Date` |
| `"date"` | `0`, `"0"` | `null` (sentinela histórica de "sem data") |
| `"date"` | string inválida | `null` |
| qualquer outro nome | qualquer valor | passa direto, sem conversão |

`null` e `undefined` viram `null` em **todos** os tipos, antes de qualquer conversor rodar.

---

## 2. Temporal

Todo tipo do Temporal é aceito por três formas equivalentes: nome canônico (`"zoneddatetime"`),
nome qualificado (`"Temporal.ZonedDateTime"`) e o construtor (`Temporal.ZonedDateTime`). Alguns
têm apelido curto.

| Tipo | Apelido | Entrada | Saída |
| --- | --- | --- | --- |
| `"zoneddatetime"` | `"zoned"` | `"2026-01-15T10:00:00-03:00[America/Sao_Paulo]"` | `ZonedDateTime` — **IANA mantida** |
| | | `"2026-01-15T10:00:00-03:00"` | `ZonedDateTime` com fuso `-03:00` |
| | | `"2026-01-15 10:00:00-03:00"` (separador com espaço) | `ZonedDateTime` com fuso `-03:00` |
| | | `"2026-01-15T13:00:00Z"` | `ZonedDateTime` em `UTC` |
| | | `"2026-01-15T10:00:00"`, `"15/01/2026"`, `Date`, epoch | fuso do sistema |
| `"instant"` | — | ISO com `Z`/offset, epoch (s ou ms), `Date`, `ZonedDateTime` | `Instant` |
| `"plaindate"` | — | `"2026-01-15"`, `"15/01/2026"`, `Date`, `ZonedDateTime` | `PlainDate` |
| `"plaindatetime"` | `"datetime"` | `"2026-01-15T10:30:00"`, `"15/01/2026 10:30:45"` | `PlainDateTime` |
| `"plaintime"` | `"time"` | `"10:30"`, `"10:30:45"`, `Date`, epoch | `PlainTime` |
| `"plainyearmonth"` | `"yearmonth"` | `"2026-01"`, `"2026-01-15"`, `"15/01/2026"` | `PlainYearMonth` |
| `"plainmonthday"` | `"monthday"` | `"--01-15"`, `"01-15"`, `"15/01/2026"` | `PlainMonthDay` |
| `"duration"` | — | `"PT1H30M"`, `{hours: 1, minutes: 30}`, `5400000` (ms) | `Duration` |
| qualquer um | | valor que nenhuma estratégia lê | `null` |

Cada tipo aceita, além do formato nativo do `Temporal.X.from`, **todo formato que o `parseDate` já
entendia**: BR `DD/MM/YYYY` (com ou sem hora), ISO, RFC, epoch em segundos ou milissegundos, `Date`,
outro valor do Temporal e property bag.

### Time zone

O fuso que veio no payload é **preservado**:

| Payload | `zoneddatetime` resultante |
| --- | --- |
| `…-03:00[America/Sao_Paulo]` | `[America/Sao_Paulo]` — a anotação IANA continua na string |
| `…-03:00` | fuso `-03:00` (o offset da própria string) |
| `…Z` | `UTC` |
| sem fuso nenhum (BR, `Date`, epoch, ISO sem offset) | `Temporal.Now.timeZoneId()` |

`toString()` e `JSON.stringify` devolvem a string completa, colchetes inclusive.

### Dois cuidados que o conversor já resolve

- **Data sem hora não troca de dia.** `"2026-01-15"` vira meia-noite **do dia 15** no fuso do
  sistema. Passar pelo `new Date("2026-01-15")` (que assume UTC) devolveria o dia 14 em qualquer
  fuso negativo — por isso a string ISO sem offset é lida como hora de parede, não como UTC.
- **Hora não é inventada.** `"2026-01-15"` num campo `"plaintime"` devolve `null`, e não a
  meia-noite (ou a hora que sobra do deslocamento de fuso).

### Onde o tipo Temporal também aparece

- `"date"` aceita valor do Temporal na ENTRADA (`ZonedDateTime`, `Instant`, `PlainDate`,
  `PlainDateTime`, `PlainTime`) e devolve `Date`.
- O `getWhere` trata `instant`, `zoneddatetime`, `plaindate` e `plaindatetime` como data — o filtro
  de igualdade vira o intervalo do dia (`gte` 00:00:00 / `lte` 23:59:59.999), igual a `"date"`.
  `plaintime`, `plainyearmonth`, `plainmonthday` e `duration` **não** entram nessa regra.

---

## 3. Models aninhados

| Declarado como | Valor recebido | Resultado |
| --- | --- | --- |
| `@Field(Model)` | objeto | instância de `Model` |
| `@Field(Model)` | **array** | array de instâncias de `Model` |
| `@Field([Model])` | array | array de instâncias de `Model` |
| `@Field([Model])` | objeto | array com uma instância de `Model` |
| qualquer um | `null` | `null` |

A conversão é recursiva: se o model aninhado também tem `setData` com `@AutoConvert`, os campos dele
passam pelas mesmas regras. Array é sempre convertido item a item, **mesmo num campo to-one** — sem
isso, o array inteiro iria para o `setData` de uma instância só, nenhuma chave bateria e sobrariam
apenas os defaults da superclasse.

---

## 4. Tipagem

Os tipos exportados pelo pacote, para quem quer declarar o próprio helper em cima do `@Field`:

```ts
import type {
  FieldType, // tudo que o @Field aceita
  FieldTypeName, // os nomes em string (com autocomplete)
  NestedModelType, // model aninhado
  PrimitiveFieldType, // "string" | "number" | "bigint" | "boolean" | "date"
  TemporalConstructor, // Temporal.ZonedDateTime | Temporal.PlainDate | …
  TemporalFieldType, // "zoneddatetime" | "Temporal.PlainDate" | "time" | …
} from "@mateusseiboth/ts-decorators";
```

`FieldTypeName` inclui `(string & {})`: os literais existem para o editor sugerir, mas nome livre
continua válido — o `@AutoConvert` simplesmente deixa o valor como veio.

---

## 5. Modo legacy vs TC39

| Modo | `@Field()` | `@Field("number")` |
| --- | --- | --- |
| Legacy (`emitDecoratorMetadata: true`) | tipo inferido pelo `reflect-metadata` — inclusive `Temporal.PlainDate` → `"plaindate"` | funciona (explícito vence) |
| TC39 Stage 3 (sem `emitDecoratorMetadata`) | vira `"any"` — **sempre passe o tipo** | obrigatório |
