declare module "pg" {
  export interface PoolConfig {
    connectionString?: string;
    ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string };
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    allowExitOnIdle?: boolean;
    maxUses?: number;
    application_name?: string;
    [key: string]: unknown;
  }

  export interface QueryResult<Row extends object = Record<string, unknown>> {
    rows: Row[];
    rowCount?: number | null;
  }

  /**
   * A single checked-out connection. Required for transactions: Pool.query may
   * use a different connection per call, so `begin`/`commit` issued against the
   * pool are not guaranteed to land on the same session.
   */
  export interface PoolClient {
    query<Row extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
    release(): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    query<Row extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
}

declare module "@aws-sdk/client-ses" {
  export interface SESClientConfig {
    region?: string;
  }

  export interface SendEmailCommandInput {
    Source?: string;
    Destination?: {
      ToAddresses?: string[];
    };
    Message?: {
      Subject?: {
        Data?: string;
        Charset?: string;
      };
      Body?: {
        Html?: {
          Data?: string;
          Charset?: string;
        };
        Text?: {
          Data?: string;
          Charset?: string;
        };
      };
    };
  }

  export class SESClient {
    constructor(config?: SESClientConfig);
    send(command: SendEmailCommand): Promise<unknown>;
  }

  export class SendEmailCommand {
    constructor(input: SendEmailCommandInput);
  }
}
