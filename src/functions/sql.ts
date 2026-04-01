export interface IResponsePaginate<T> {
  data: {
    data: T[];
    paginacao: {
      total?: number;
      page?: number;
    };
  };
}

export function convertBigIntValues<T>(data: T): T {
  if (Array.isArray(data)) {
    return data.map((item) => convertBigIntValues(item)) as unknown as T;
  }

  if (data instanceof Date) {
    return data.toISOString() as unknown as T;
  }

  if (data !== null && typeof data === "object") {
    return Object.entries(data).reduce((acc, [key, value]) => {
      acc[key as keyof T] = typeof value === "bigint" ? value.toString() : convertBigIntValues(value);
      return acc;
    }, {} as T);
  }

  return data;
}

export async function executePrismaQuery<T>(
  objectPrismaQuery: any,
  options: any & {skip?: number; take?: number; page?: number; where?: any; include?: any; distinct?: any; select?: any},
): Promise<IResponsePaginate<T>> {
  const paginate = {
    count: 0,
    page: options.page,
    take: options.take,
  };
  delete options.page;

  const ids = await objectPrismaQuery.findMany({
    where: options.where,
    select: {id: true},
    orderBy: options.orderBy,
    skip: options.skip,
    take: options.take,
  });

  if (!ids.length) {
    return {
      data: [] as any,
      paginate: {totalPage: 0, page: 1, total: 0},
    } as any;
  }

  const data = await objectPrismaQuery.findMany({
    where: {
      id: {in: ids.map((i: any) => i.id)},
    },
    orderBy: options.orderBy,
    include: options.include,
  });

  const treatedDataWithBigIntToString = convertBigIntValues(data);

  paginate.count = await objectPrismaQuery.count(options);
  const responseWithPaginate = {
    data: {
      data: treatedDataWithBigIntToString,
      paginacao: {
        totalPage: paginate.count,
        page: paginate.page,
        total: Math.ceil(paginate.count / (paginate.take || 10)),
      },
    },
  };
  return responseWithPaginate;
}

export function addCompanyIdToTransaction(tx: any, companyId: string) {
  console.log("[@mateusseiboth/ts-commons] Transaction started for company ID:", companyId);
  return tx.$executeRawUnsafe(`SET LOCAL "my.company_id" = ${Number(companyId)}`);
}
