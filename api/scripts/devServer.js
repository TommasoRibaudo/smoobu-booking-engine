#!/usr/bin/env node
/**
 * Local HTTP server around the Lambda handler.
 *
 * The deployed API is invoked by API Gateway with a payload-format-2.0 event.
 * This translates ordinary Node requests into that shape and writes the handler's
 * ApiResponse back out, so the same code path runs locally and in AWS with no
 * branching inside the handler itself.
 *
 * Run `npm run build` first (or use `npm run dev`, which does both).
 */

const http = require("http");
const path = require("path");
const { loadEnvFiles } = require("./loadEnv");

loadEnvFiles();

const PORT = Number(process.env.BOOKING_API_DEV_PORT || 4000);

// Required after loadEnvFiles() so loadConfig() sees the local environment.
const distPath = path.resolve(__dirname, "..", "dist", "app.js");
let createBookingApiHandler;
try {
  ({ createBookingApiHandler } = require(distPath));
} catch (error) {
  console.error(`\nCould not load ${distPath}.`);
  console.error("Build the API first:  npm --prefix booking-api run build\n");
  throw error;
}

const handler = createBookingApiHandler();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Node request -> API Gateway HTTP API payload format 2.0. */
function toLambdaEvent(req, rawBody, url) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = Array.isArray(value) ? value.join(",") : value;
  }

  const queryStringParameters = {};
  for (const [key, value] of url.searchParams.entries()) {
    queryStringParameters[key] = value;
  }

  // Strip the IPv6-mapped IPv4 prefix so abuse-protection buckets and the
  // `inet` columns see the same address shape they do behind API Gateway.
  const sourceIp = (req.socket.remoteAddress || "127.0.0.1").replace(/^::ffff:/, "");

  return {
    version: "2.0",
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ""),
    queryStringParameters,
    headers,
    body: rawBody.length > 0 ? rawBody.toString("utf8") : undefined,
    isBase64Encoded: false,
    requestContext: {
      http: {
        method: req.method,
        path: url.pathname,
        sourceIp,
        userAgent: headers["user-agent"],
      },
    },
  };
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

  try {
    const rawBody = await readBody(req);
    const event = toLambdaEvent(req, rawBody, url);
    const result = await handler(event);

    res.writeHead(result.statusCode, result.headers || {});
    res.end(result.body ?? "");

    const durationMs = Date.now() - startedAt;
    console.log(`${req.method} ${url.pathname} -> ${result.statusCode} (${durationMs}ms)`);
  } catch (error) {
    // The handler maps its own errors; reaching here means the adapter itself
    // failed, which is a bug worth seeing in full.
    console.error(`${req.method} ${url.pathname} -> adapter error`, error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "dev_server_error", message: String(error) } }));
  }
});

server.listen(PORT, () => {
  console.log(`booking-api dev server listening on http://localhost:${PORT}`);
  console.log(`  health:   http://localhost:${PORT}/api/health`);
  console.log(`  smoobu:   ${process.env.SMOOBU_BASE_URL || "(unset — will call the real Smoobu API)"}`);
  console.log(`  paypal:   ${process.env.PAYPAL_BASE_URL || "(unset)"}`);
});
