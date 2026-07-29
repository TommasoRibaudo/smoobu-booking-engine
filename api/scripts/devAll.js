#!/usr/bin/env node
/**
 * Starts the provider mocks and the booking API dev server together, so local
 * work needs one terminal rather than two. Ctrl-C stops both.
 *
 * Assumes `npm run build` has already run — `npm run dev` chains them.
 */

const { spawn } = require("child_process");
const path = require("path");
const { loadEnvFiles } = require("./loadEnv");

// Load once here so both children inherit the same environment (the mock server
// reads MOCK_PROVIDERS_PORT, which otherwise wouldn't be set).
loadEnvFiles();

const scriptsDir = __dirname;
const children = [];
let shuttingDown = false;

const ESC = String.fromCharCode(27);

function start(name, scriptFile, colorCode) {
  const child = spawn(process.execPath, [path.join(scriptsDir, scriptFile)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const prefix = ESC + '[' + colorCode + 'm[' + name + ']' + ESC + '[0m';

  const forward = (stream, target) => {
    stream.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) {
          target.write(`${prefix} ${line}\n`);
        }
      }
    });
  };

  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    console.error(`${prefix} exited (code=${code} signal=${signal ?? "none"}) — stopping the rest.`);
    shutdown(code ?? 1);
  });

  children.push(child);
  return child;
}

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  // Give children a moment to close listeners before the parent exits.
  setTimeout(() => process.exit(exitCode), 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("mocks", "mockProviders.js", "36");
start("api", "devServer.js", "32");
