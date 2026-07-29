/**
 * migrationHandler.ts — applies pending SQL migrations from inside the VPC.
 *
 * RDS is private and its security group admits port 5432 from the Lambda
 * security group only, so `npm run migrate` cannot reach it from a laptop or
 * from a GitHub Actions runner. This Lambda sits in that security group and is
 * the sanctioned way to migrate a deployed environment.
 *
 * It is invoked manually (or by CI before a code deploy) — never on a schedule.
 * Ordering matters: a migration must land *before* the code that reads the new
 * columns, or every query against the changed table fails.
 *
 * Semantics match scripts/migrate.js exactly — one transaction for the whole
 * run, an exclusive table lock so two concurrent invocations cannot interleave,
 * and a checksum per applied file so an already-applied migration can never be
 * edited underneath us.
 */

import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool, PoolClient } from "pg";
import { createPoolConfig } from "./db";
import { createSecretProvider } from "./secrets";

const MIGRATIONS_TABLE_IDENT = '"schema_migrations"';

export interface MigrationEvent {
  /** Report what would be applied without changing anything. */
  dryRun?: boolean;
}

export interface MigrationResult {
  ok: boolean;
  applied: string[];
  pending: string[];
  alreadyApplied: number;
  /** Rows whose stored checksum was re-recorded after a line-ending-only change. */
  healed: string[];
  dryRun: boolean;
  error?: string;
}

/**
 * Migrations are copied next to the compiled JS by the build step, so they sit
 * at /var/task/migrations in the deployed package. The parent-directory fallback
 * keeps `ts-node`/jest runs working from src/.
 */
function resolveMigrationsDir(): string {
  const candidates = [join(__dirname, "migrations"), join(__dirname, "..", "migrations")];

  for (const candidate of candidates) {
    try {
      if (listMigrationFiles(candidate).length > 0) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`No migration files found. Looked in: ${candidates.join(", ")}`);
}

function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Checksums are computed on LF-normalised content.
 *
 * A Windows checkout yields CRLF for some files and LF for others, so the same
 * migration hashed on a laptop and on a Linux CI runner produced different
 * values — indistinguishable from someone editing an applied migration, and it
 * failed the first production deploy on 0011. Normalising makes the checksum a
 * property of the SQL rather than of the machine that read it.
 */
function canonicalChecksum(sql: string): string {
  return sha256(sql.replace(/\r\n/g, "\n"));
}

/**
 * Checksums recorded before normalisation existed: the raw bytes as read, and
 * the fully-CRLF form. Matching one of these proves the content is identical
 * apart from line endings, so the row can be healed rather than rejected.
 * Anything else is a genuine edit and still fails.
 */
function legacyChecksums(sql: string): string[] {
  const lf = sql.replace(/\r\n/g, "\n");
  return [sha256(sql), sha256(lf.replace(/\n/g, "\r\n"))];
}

async function loadAppliedMigrations(client: PoolClient): Promise<Map<string, string>> {
  const result = await client.query<{ filename: string; checksum: string }>(
    `select filename, checksum from ${MIGRATIONS_TABLE_IDENT}`
  );
  return new Map(result.rows.map((row) => [row.filename, row.checksum]));
}

export async function handler(event: MigrationEvent = {}): Promise<MigrationResult> {
  const dryRun = event.dryRun === true;
  const migrationsDir = resolveMigrationsDir();
  const migrationFiles = listMigrationFiles(migrationsDir);

  const { rdsConnectionString } = await createSecretProvider().getSecrets();
  // Reuses the API's pool config so the RDS regional CA bundle is trusted —
  // plain rejectUnauthorized fails against RDS with SELF_SIGNED_CERT_IN_CHAIN.
  const pool = new Pool(createPoolConfig(rdsConnectionString, { max: 1 }));

  const applied: string[] = [];
  const pending: string[] = [];
  const healed: string[] = [];
  let alreadyApplied = 0;

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`
      create table if not exists ${MIGRATIONS_TABLE_IDENT} (
        id bigserial primary key,
        filename text not null unique,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);
    await client.query(`lock table ${MIGRATIONS_TABLE_IDENT} in exclusive mode`);

    const appliedMap = await loadAppliedMigrations(client);

    for (const filename of migrationFiles) {
      const sql = readFileSync(join(migrationsDir, filename), "utf8");
      const checksum = canonicalChecksum(sql);
      const appliedChecksum = appliedMap.get(filename);

      if (appliedChecksum) {
        if (appliedChecksum !== checksum) {
          if (!legacyChecksums(sql).includes(appliedChecksum)) {
            throw new Error(
              `Applied migration ${filename} has checksum ${appliedChecksum}, but the packaged file is ${checksum}. ` +
                `An applied migration must never be edited — fix it with a new numbered migration.`
            );
          }

          // Same SQL, different line endings. Re-record the canonical checksum
          // so this file stops mismatching on every future run.
          if (!dryRun) {
            await client.query(`update ${MIGRATIONS_TABLE_IDENT} set checksum = $1 where filename = $2`, [
              checksum,
              filename,
            ]);
          }
          healed.push(filename);
        }
        alreadyApplied += 1;
        continue;
      }

      pending.push(filename);

      if (dryRun) {
        continue;
      }

      await client.query(sql);
      await client.query(`insert into ${MIGRATIONS_TABLE_IDENT} (filename, checksum) values ($1, $2)`, [
        filename,
        checksum,
      ]);
      applied.push(filename);
    }

    // A dry run still rolls back, so the schema_migrations bootstrap above
    // leaves no trace on a database that has never been migrated.
    await client.query(dryRun ? "rollback" : "commit");

    return { ok: true, applied, pending, alreadyApplied, healed, dryRun };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    return {
      ok: false,
      applied: [],
      pending,
      alreadyApplied,
      healed,
      dryRun,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}
