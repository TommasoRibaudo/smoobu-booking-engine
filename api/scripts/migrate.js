#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const MIGRATIONS_TABLE = "schema_migrations";
// Quoted identifier used in DDL/DML statements where interpolation is required.
// The name is a hardcoded constant (never user-supplied), but quoting it makes
// the intent explicit and prevents any future accidental injection if the
// constant is ever made configurable.
const MIGRATIONS_TABLE_IDENT = `"${MIGRATIONS_TABLE}"`;

async function main() {
  const migrationsDir = path.resolve(__dirname, "..", "migrations");
  const migrationFiles = listMigrationFiles(migrationsDir);

  if (migrationFiles.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}.`);
  }

  const pool = new Pool({
    connectionString: getConnectionString(),
    ssl: getSslConfig(),
  });

  try {
    await runMigrations(pool, migrationsDir, migrationFiles);
  } finally {
    await pool.end();
  }
}

function listMigrationFiles(migrationsDir) {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

async function runMigrations(pool, migrationsDir, migrationFiles) {
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

    const applied = await loadAppliedMigrations(client);
    let appliedCount = 0;

    for (const filename of migrationFiles) {
      const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
      const checksum = sha256(sql);
      const appliedChecksum = applied.get(filename);

      if (appliedChecksum) {
        if (appliedChecksum !== checksum) {
          throw new Error(`Applied migration ${filename} has checksum ${appliedChecksum}, but the local file is ${checksum}.`);
        }
        continue;
      }

      process.stdout.write(`Applying ${filename}... `);
      await client.query(sql);
      await client.query(
        `insert into ${MIGRATIONS_TABLE_IDENT} (filename, checksum) values ($1, $2)`,
        [filename, checksum]
      );
      appliedCount += 1;
      process.stdout.write("done\n");
    }

    await client.query("commit");
    console.log(
      appliedCount === 0
        ? "No pending migrations."
        : `Applied ${appliedCount} migration${appliedCount === 1 ? "" : "s"}.`
    );
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadAppliedMigrations(client) {
  const result = await client.query(`select filename, checksum from ${MIGRATIONS_TABLE_IDENT}`);
  return new Map(result.rows.map((row) => [row.filename, row.checksum]));
}

function getConnectionString() {
  const direct = trim(process.env.BOOKING_API_RDS_CONNECTION_STRING) || trim(process.env.DATABASE_URL);
  if (direct) {
    return direct;
  }

  const secretJson = trim(process.env.BOOKING_API_SECRETS_JSON);
  if (secretJson) {
    const parsed = JSON.parse(secretJson);
    if (typeof parsed.rdsConnectionString === "string" && parsed.rdsConnectionString.trim()) {
      return parsed.rdsConnectionString.trim();
    }
  }

  throw new Error(
    "Database connection string is required. Set BOOKING_API_RDS_CONNECTION_STRING, DATABASE_URL, or BOOKING_API_SECRETS_JSON.rdsConnectionString."
  );
}

function getSslConfig() {
  const sslMode = trim(process.env.BOOKING_API_MIGRATION_SSL);
  if (sslMode && ["0", "false", "off", "disable"].includes(sslMode.toLowerCase())) {
    return false;
  }

  return {
    rejectUnauthorized: trim(process.env.BOOKING_API_MIGRATION_SSL_REJECT_UNAUTHORIZED) !== "false",
  };
}

function sha256(value) {
  return require("crypto").createHash("sha256").update(value).digest("hex");
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
