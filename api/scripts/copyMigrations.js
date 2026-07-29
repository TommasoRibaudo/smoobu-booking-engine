#!/usr/bin/env node

/**
 * Copies migrations/*.sql next to the compiled JS.
 *
 * The migration Lambda (src/migrationHandler.ts) reads them at runtime from
 * /var/task/migrations, and the Lambda package is built from dist/ alone — so
 * without this step the function deploys with nothing to apply.
 */

const fs = require("fs");
const path = require("path");

const source = path.resolve(__dirname, "..", "migrations");
const target = path.resolve(__dirname, "..", "dist", "migrations");

fs.mkdirSync(target, { recursive: true });

const files = fs.readdirSync(source).filter((name) => /^\d{4}_.+\.sql$/.test(name));
for (const file of files) {
  fs.copyFileSync(path.join(source, file), path.join(target, file));
}

console.log(`Copied ${files.length} migration${files.length === 1 ? "" : "s"} to dist/migrations.`);
