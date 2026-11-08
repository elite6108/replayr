// Local Postgres race for the pending-game cap. Refuses every non-local host.
// This creates and drops a database named replayr_cap_test. It does not touch hosted SQL.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const parsed = new URL(databaseUrl);
if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
  console.error("Refusing to run the pending-game race against a non-local database.");
  process.exit(1);
}

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../supabase/migrations/20261108032000_games_column_revoke_and_pending_cap.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const userId = "11111111-1111-4111-8111-111111111111";

const admin = new pg.Client({ connectionString: databaseUrl });
await admin.connect();
try {
  await admin.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'replayr_cap_test' and pid <> pg_backend_pid()",
  );
  await admin.query("drop database if exists replayr_cap_test");
  await admin.query("create database replayr_cap_test");
} finally {
  await admin.end();
}

const capUrl = new URL(databaseUrl);
capUrl.pathname = "/replayr_cap_test";
const pool = new pg.Pool({ connectionString: capUrl.toString(), max: 12 });

try {
  await pool.query(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin;
      end if;
    end $$;
    create table public.games (
      id uuid primary key default gen_random_uuid(),
      slug text not null unique,
      name text not null,
      publisher text,
      cover_url text,
      icon_url text,
      created_at timestamptz not null default now(),
      parent_game_id uuid,
      status text not null,
      catalog_source text not null,
      igdb_id bigint,
      steam_app_id text,
      aliases text[] not null default '{}',
      created_by uuid,
      process_names text[] not null default '{}'
    );
  `);
  await pool.query(migrationSql);

  const attempts = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      pool
        .query("select public.create_user_pending_game($1, $2, $3, $4) as slug", [
          userId,
          `race-game-${index}`,
          `Race Game ${index}`,
          `race game ${index}`,
        ])
        .then(
          (result) => ({ ok: true, slug: result.rows[0].slug }),
          (error) => ({ ok: false, code: error.code, message: String(error.message) }),
        ),
    ),
  );
  const stored = await pool.query(
    "select count(*)::integer as count from public.games where created_by = $1 and status = 'pending' and catalog_source = 'user'",
    [userId],
  );
  const privileges = await pool.query(`
    select
      has_function_privilege('anon', 'public.create_user_pending_game(uuid, text, text, text)', 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', 'public.create_user_pending_game(uuid, text, text, text)', 'EXECUTE') as auth_execute,
      has_function_privilege('service_role', 'public.create_user_pending_game(uuid, text, text, text)', 'EXECUTE') as service_execute
  `);

  const client = await pool.connect();
  let upgrade;
  try {
    await client.query("begin");
    await client.query(
      "grant select (catalog_source, igdb_id, steam_app_id, aliases) on table public.games to anon, authenticated",
    );
    await client.query("revoke select on table public.games from public, anon, authenticated");
    await client.query(`
      grant select (id, slug, name, publisher, cover_url, icon_url, created_at, parent_game_id, status)
      on table public.games to anon, authenticated
    `);
    const afterTableRevoke = await client.query(`
      select
        has_column_privilege('anon', 'public.games', 'steam_app_id', 'SELECT') as anon_steam,
        has_column_privilege('anon', 'public.games', 'name', 'SELECT') as anon_name
    `);
    await client.query(
      "revoke select (catalog_source, igdb_id, steam_app_id, aliases) on table public.games from public, anon, authenticated",
    );
    const afterColumnRevoke = await client.query(`
      select
        has_column_privilege('anon', 'public.games', 'steam_app_id', 'SELECT') as anon_steam,
        has_column_privilege('anon', 'public.games', 'name', 'SELECT') as anon_name
    `);
    await client.query("rollback");
    upgrade = {
      tableRevokeLeavesSteam: afterTableRevoke.rows[0].anon_steam,
      tableRevokeKeepsName: afterTableRevoke.rows[0].anon_name,
      columnRevokeHidesSteam: afterColumnRevoke.rows[0].anon_steam === false,
      columnRevokeKeepsName: afterColumnRevoke.rows[0].anon_name,
    };
  } finally {
    client.release();
  }

  const succeeded = attempts.filter((attempt) => attempt.ok);
  const rejected = attempts.filter((attempt) => !attempt.ok);
  const report = {
    inserted: stored.rows[0].count,
    succeeded: succeeded.length,
    rejected: rejected.length,
    rejectedForCap: rejected.every((attempt) => attempt.code === "P0001" && /pending game cap/i.test(attempt.message)),
    privileges: privileges.rows[0],
    upgrade,
    note: "Local Postgres only. Hosted SQL was not changed.",
  };
  console.log(JSON.stringify(report));
  const privilegesOk =
    report.privileges.anon_execute === false &&
    report.privileges.auth_execute === false &&
    report.privileges.service_execute === true;
  const upgradeOk =
    upgrade.tableRevokeLeavesSteam === true &&
    upgrade.tableRevokeKeepsName === true &&
    upgrade.columnRevokeHidesSteam === true &&
    upgrade.columnRevokeKeepsName === true;
  if (report.inserted !== 10 || report.succeeded !== 10 || report.rejected !== 2 || !report.rejectedForCap || !privilegesOk || !upgradeOk) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
  const cleanup = new pg.Client({ connectionString: databaseUrl });
  await cleanup.connect();
  try {
    await cleanup.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'replayr_cap_test' and pid <> pg_backend_pid()",
    );
    await cleanup.query("drop database if exists replayr_cap_test");
  } finally {
    await cleanup.end();
  }
}
