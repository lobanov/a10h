import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const _dirname = dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "autoresearch",
  password: process.env.PGPASSWORD ?? "autoresearch-dev",
  database: process.env.PGDATABASE ?? "autoresearch",
});

export async function migrate(): Promise<void> {
  const sql = readFileSync(join(_dirname, "schema.sql"), "utf8");
  await pool.query(sql);
}
