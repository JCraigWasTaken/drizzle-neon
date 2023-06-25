import type { Config } from 'drizzle-kit';
import * as dotenv from 'dotenv';
dotenv.config();

export default {
  schema: './schema/**/schema.ts',
  out: './migrations',
  connectionString: process.env['DATABASE_URL'],
  breakpoints: true,
} satisfies Config;
