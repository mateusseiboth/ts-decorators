# @mateusseiboth/ts-decorators

Decorators, middlewares do Express e funções para API REST com Bun, Express e Prisma 7 e 8.
Publicado como **código-fonte** (`module: index.ts`), direto do GitHub
(`github:mateusseiboth/ts-decorators`). Nasceu da mesma origem da base comum da empresa e
recebeu o porte dela na 2.0 (veja `CHANGELOG.md`); não depende de nenhum pacote privado.

## Regras deste repositório

- **Sem alias de import no `src/`.** No projeto que consome, um alias apontaria para o `src` DELE.
  Todo import interno é relativo.
- **Sem `enum`.** O próprio lint roda a regra `ts-decorators/no-enum` (`src/oxlint/no-enum.mjs`).
- **Portão**, nesta ordem: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test`.
- **Versão nova** entra no topo do `CHANGELOG.md`, no mesmo commit que sobe o `package.json`.
  Export, opção ou comportamento novo atualiza o `README.md` no mesmo commit.
- Prisma 7 e Prisma 8 por duck typing: transação do 7 tem `$executeRawUnsafe`, a do 8 tem
  `execute`/`query`/`orm`. O pacote não importa nenhum dos dois; o 8 é registrado com
  `configurePrisma8`.
- **Tenant** passa SEMPRE pelo `CompanyIdInjector` (`src/handlers/companyId.ts`): nada de
  `SET LOCAL` fixo nem id colado no texto do SQL. O padrão é
  `set_config('my.company_id', $1, true)` com o id como parâmetro de texto (UUID ou número).
- Os middlewares de consulta publicam em `res.locals` E no contexto (`publishRequestValue`).

## Pontos de entrada

`.` (`index.ts`), `./testing` (`src/testing/prisma8Fakes.ts`), `./oxlint`
(`src/oxlint/no-enum.mjs`) e o binário `ts-decorators` (`src/cli/index.ts`, Studio).
