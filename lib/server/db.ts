import { Pool, type QueryResultRow } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { LINKQT_SCHEMA_SQL } from "./schema";

const STALE_PENDING_MS = Number(process.env.LINKQT_STALE_PENDING_MS ?? 15 * 60_000);

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function databaseUrl() {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "";
  if (!url.trim()) throw new Error("DATABASE_URL is not set.");
  return url;
}

export function getPool() {
  if (pool) return pool;
  pool = new Pool({ connectionString: databaseUrl(), max: 5 });
  attachDatabasePool(pool);
  return pool;
}

function toPg(sql: string) {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

export async function queryOne<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
  const result = await getPool().query<T>(toPg(sql), params);
  return result.rows[0];
}

export async function queryAll<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
  const result = await getPool().query<T>(toPg(sql), params);
  return result.rows;
}

export async function queryRun(sql: string, params: unknown[] = []) {
  await getPool().query(toPg(sql), params);
}

export async function ensureSchema() {
  schemaReady ??= (async () => {
    const statements = LINKQT_SCHEMA_SQL.split(";").map((part) => part.trim()).filter(Boolean);
    const client = getPool();
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query(`
      do $$
      begin
        if exists (
          select 1
          from information_schema.referential_constraints
          where constraint_schema = current_schema()
            and constraint_name = 'builder_runs_parent_run_id_fkey'
            and delete_rule = 'CASCADE'
        ) then
          alter table builder_runs drop constraint builder_runs_parent_run_id_fkey;
          alter table builder_runs
            add constraint builder_runs_parent_run_id_fkey
            foreign key (parent_run_id) references builder_runs(id) on delete restrict;
        end if;
      end $$;
    `);
    await client.query("delete from idempotency_keys where created_at < $1", [new Date(Date.now() - 24 * 60 * 60_000).toISOString()]);
  })();
  await schemaReady;
}

export async function failStalePendingRuns(maxAgeMs = STALE_PENDING_MS) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  await queryRun("update builder_runs set status = 'failed' where status = 'pending' and created_at < ?", [cutoff]);
}

export async function currentDeploymentDocument(siteKey: string) {
  return queryOne<{ document: string }>("select document from deployments where site_key = ? order by deployed_at desc limit 1", [siteKey]);
}
