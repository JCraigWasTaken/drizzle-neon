import { InferModel } from 'drizzle-orm';
import { RequiredProperties } from '../util';
import {
  PgTableWithColumns,
  decimal,
  pgEnum,
  pgTable,
  serial,
  timestamp,
} from 'drizzle-orm/pg-core';

export const operationEnum = pgEnum('operation', [
  'plus',
  'minus',
  'times',
  'divide',
]);

export const EquationTable = pgTable('equation', {
  id: serial('id').primaryKey(),
  date: timestamp('date').defaultNow(),
  varA: decimal('varA').notNull(),
  operation: operationEnum('operation').notNull(),
  varB: decimal('varB').notNull(),
  result: decimal('result').notNull(),
});

export type TEquationTableRow = InferModel<typeof EquationTable, 'insert'>;
type TEquationTable = typeof EquationTable;
export type TEquationTableColumns =
  TEquationTable extends PgTableWithColumns<infer TC> ? TC : never;
