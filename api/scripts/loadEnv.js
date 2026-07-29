#!/usr/bin/env node
/**
 * Minimal .env loader for local scripts.
 *
 * The Lambda gets its configuration from the AWS environment, so the API has no
 * dotenv dependency and none is added here. Load order, later files winning:
 *
 *   booking-api/.env         real provider credentials (gitignored)
 *   booking-api/.env.local   local overrides — mock providers, local Postgres
 *
 * Variables already present in the process environment are never overwritten,
 * so `SMOOBU_BASE_URL=... npm run dev` still wins over both files.
 */

const fs = require("fs");
const path = require("path");

function parseEnvFile(contents) {
  const values = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    // Strip matching surrounding quotes, keeping any inner ones.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function loadEnvFiles(baseDir = path.resolve(__dirname, "..")) {
  const loaded = [];

  for (const fileName of [".env", ".env.local"]) {
    const filePath = path.join(baseDir, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const values = parseEnvFile(fs.readFileSync(filePath, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      // A file later in the list overrides an earlier one, but the real process
      // environment always wins.
      if (process.env[key] === undefined || loaded.some((entry) => entry.keys.includes(key))) {
        process.env[key] = value;
      }
    }

    loaded.push({ file: fileName, keys: Object.keys(values) });
  }

  if (loaded.length > 0) {
    console.log(`loaded env from ${loaded.map((entry) => entry.file).join(", ")}`);
  }

  return loaded;
}

module.exports = { loadEnvFiles, parseEnvFile };
