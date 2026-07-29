#!/usr/bin/env node
/**
 * Runs migrations against the local docker-compose Postgres.
 *
 * scripts/migrate.js reads its connection details straight from the process
 * environment, which in AWS comes from Secrets Manager. Locally those live in
 * booking-api/.env.local, so this loads them first and then delegates.
 */

const path = require("path");
const { loadEnvFiles } = require("./loadEnv");

loadEnvFiles();

if (!process.env.BOOKING_API_RDS_CONNECTION_STRING && !process.env.DATABASE_URL) {
  console.error(
    "\nNo database connection string found.\n" +
      "Copy booking-api/.env.local.example to booking-api/.env.local, then run:\n" +
      "  docker compose up -d\n"
  );
  process.exit(1);
}

// Local Postgres speaks plaintext; the migration runner defaults to requiring TLS.
if (process.env.BOOKING_API_MIGRATION_SSL === undefined) {
  process.env.BOOKING_API_MIGRATION_SSL = "false";
}

require(path.join(__dirname, "migrate.js"));
