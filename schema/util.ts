import { faker } from '@faker-js/faker';
import { PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import 'dotenv/config';
import { TableConfig } from 'drizzle-orm';
import { AnyPgColumn, PgTableWithColumns } from 'drizzle-orm/pg-core';
import postgres from 'postgres';

export abstract class RefreshTestData<
  T,
  R extends TableConfig<AnyPgColumn<{}>>
> {
  protected db: PostgresJsDatabase<Record<string, never>>;

  constructor(
    seed: number,
    protected table: PgTableWithColumns<R>,
    protected numRows: number = 10
  ) {
    faker.seed(seed);
    const url = `${process.env.DATABASE_URL}`;
    this.db = drizzle(postgres(url, { ssl: 'require', max: 1 }));
  }

  abstract generateRow(): T;

  async generateRows(count: number): Promise<T[]> {
    let rows: T[] = [];
    for (let i = 0; i < count; i++) {
      rows.push(this.generateRow());
    }
    return rows;
  }

  async deleteAllRowsFromDBTable(): Promise<void> {
    await this.db.delete(this.table);
  }

  async pushRowsToDBTable(): Promise<void> {
    const rows = await this.generateRows(this.numRows);
    try {
      // @ts-ignore
      await this.db.insert(this.table).values(rows);
    } catch (e) {
      console.log(e);
    }
  }
}

export type RequiredProperties<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

export function roundToTwoDecimalPlaces(num: number): number {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}
