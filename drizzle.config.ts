import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';
dotenv.config();

export default defineConfig({
  dialect: 'postgresql',
  schema: './schema/**/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env['DATABASE_URL'] as string },
  breakpoints: true,
});
