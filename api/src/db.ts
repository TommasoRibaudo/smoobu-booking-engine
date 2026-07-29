import { Pool, PoolConfig } from "pg";
import { ApiError } from "./http/errors";
import { RDS_CA_BUNDLE } from "./rdsCaBundle";
import { createSecretProvider } from "./secrets";
import { BookingSecretProvider } from "./types";

const HEALTH_CHECK_SQL = "SELECT 1";
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

type ForcedPoolConfig = Omit<PoolConfig, "connectionString" | "ssl">;

export interface DatabasePoolOptions {
  secretProvider?: BookingSecretProvider;
  poolConfig?: ForcedPoolConfig;
  healthCheck?: boolean;
  registerShutdownHook?: boolean;
}

let activePool: Pool | undefined;
let activePoolPromise: Promise<Pool> | undefined;
let shutdownHookRegistered = false;

export function createPoolConfig(connectionString: string, overrides: ForcedPoolConfig = {}): PoolConfig {
  return {
    ...overrides,
    connectionString,
    // RDS server certificates chain to an Amazon RDS regional CA, which is not
    // in Node's default trust store, so rejectUnauthorized alone fails every
    // connection with SELF_SIGNED_CERT_IN_CHAIN. RDS_CA_BUNDLE supplies the
    // full combined RDS CA bundle so verification succeeds for real.
    ssl: isDatabaseTlsDisabled() ? false : { rejectUnauthorized: true, ca: RDS_CA_BUNDLE },
  };
}

/**
 * Local-only escape hatch: the docker-compose Postgres speaks plaintext, so TLS
 * verification would fail before a single query ran. Mirrors the existing
 * BOOKING_API_MIGRATION_SSL flag used by scripts/migrate.js.
 *
 * Requires the exact string "false" — an unset, empty, or malformed value keeps
 * TLS on, so this can never be disabled by accident in a deployed environment.
 */
function isDatabaseTlsDisabled(): boolean {
  return process.env.BOOKING_API_DB_SSL?.trim().toLowerCase() === "false";
}

export async function createPoolFromSecrets(
  secretProvider: BookingSecretProvider,
  poolConfig: ForcedPoolConfig = {}
): Promise<Pool> {
  const { rdsConnectionString } = await secretProvider.getSecrets();
  return new Pool(createPoolConfig(rdsConnectionString, poolConfig));
}

export async function getPool(options: DatabasePoolOptions = {}): Promise<Pool> {
  if (!activePoolPromise) {
    activePoolPromise = initializePool(options);
  }

  return activePoolPromise;
}

export async function checkPoolHealth(pool: Pool): Promise<void> {
  try {
    await pool.query(HEALTH_CHECK_SQL);
  } catch (error) {
    throw databaseUnavailable("database_health_check_failed", "Database health check failed.", error);
  }
}

export async function closePool(): Promise<void> {
  const pool = activePool;
  activePool = undefined;
  activePoolPromise = undefined;

  if (pool) {
    await pool.end();
  }
}

async function initializePool(options: DatabasePoolOptions): Promise<Pool> {
  const secretProvider = options.secretProvider ?? createSecretProvider();
  const pool = await createPoolFromSecrets(secretProvider, options.poolConfig);

  try {
    if (options.healthCheck !== false) {
      await checkPoolHealth(pool);
    }
  } catch (error) {
    await closeCreatedPool(pool);
    activePool = undefined;
    activePoolPromise = undefined;
    throw error;
  }

  activePool = pool;

  if (options.registerShutdownHook !== false) {
    registerGracefulShutdownHook();
  }

  return pool;
}

function registerGracefulShutdownHook(): void {
  if (shutdownHookRegistered) {
    return;
  }

  shutdownHookRegistered = true;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void closePool().catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[booking-api] Failed to close PostgreSQL pool during shutdown.", error);
      });
    });
  }

  process.once("beforeExit", () => {
    void closePool().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[booking-api] Failed to close PostgreSQL pool before exit.", error);
    });
  });
}

async function closeCreatedPool(pool: Pool): Promise<void> {
  try {
    await pool.end();
  } catch {
    // Ignore shutdown failures after an initialization failure; the original
    // connection/health-check error is the useful failure for callers.
  }
}

function databaseUnavailable(code: string, message: string, cause: unknown): ApiError {
  if (cause instanceof ApiError) {
    return cause;
  }

  return new ApiError(503, code, message, { retryable: true });
}
