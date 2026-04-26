import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? "file:./data/budget.db";
const dbFile = url.startsWith("file:") ? url.slice("file:".length) : url;

export default {
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "sqlite",
  dbCredentials: { url: dbFile },
  verbose: true,
  strict: true,
} satisfies Config;
