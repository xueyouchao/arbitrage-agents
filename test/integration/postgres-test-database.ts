import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { Pool, QueryResultRow } from "pg";

const execFileAsync = promisify(execFile);
const POSTGRES_IMAGE = process.env.INTEGRATION_POSTGRES_IMAGE ?? "postgres:16-alpine";

export interface DisposablePostgresDatabase {
  databaseUrl: string;
  rootDatabaseUrl: string;
  databaseName: string;
  schemaName: string;
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  applyMigrations(): Promise<void>;
  close(): Promise<void>;
}

export async function createDisposablePostgresDatabase(): Promise<DisposablePostgresDatabase> {
  const server = await resolvePostgresServer();
  const root = new URL(server.rootDatabaseUrl);
  const rootDatabase = root.pathname.replace(/^\//, "");
  if (!rootDatabase || ["template0", "template1"].includes(rootDatabase)) {
    throw new Error("TEST_DATABASE_URL/DATABASE_URL must name a maintenance database, not template0/template1");
  }

  const databaseName = `arb_test_${randomUUID().replace(/-/g, "")}`;
  const rootPool = new Pool({ connectionString: root.toString() });
  await rootPool.query(`create database ${quoteIdent(databaseName)}`);
  await rootPool.end();

  const databaseUrlObject = new URL(root.toString());
  databaseUrlObject.pathname = `/${databaseName}`;
  const databaseUrl = databaseUrlObject.toString();
  const pool = new Pool({ connectionString: databaseUrl });

  return {
    databaseUrl,
    rootDatabaseUrl: root.toString(),
    databaseName,
    schemaName: "public",
    async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
      return pool.query<T>(sql, params);
    },
    async applyMigrations() {
      await runDrizzleMigrate(databaseUrl);
    },
    async close() {
      await pool.end();
      const cleanupPool = new Pool({ connectionString: root.toString() });
      try {
        await cleanupPool.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
          [databaseName]
        );
        await cleanupPool.query(`drop database if exists ${quoteIdent(databaseName)}`);
      } finally {
        await cleanupPool.end();
        if (server.containerName) await removeContainer(server.containerName);
      }
    }
  };
}

export async function withDisposablePostgresDatabase<T>(callback: (db: DisposablePostgresDatabase) => Promise<T>): Promise<T> {
  const db = await createDisposablePostgresDatabase();
  try {
    return await callback(db);
  } finally {
    await db.close();
  }
}

export async function runDrizzleMigrate(databaseUrl: string): Promise<void> {
  await execFileAsync("npx", ["drizzle-kit", "migrate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 120_000
  });
}

interface PostgresServer {
  rootDatabaseUrl: string;
  containerName?: string;
}

async function resolvePostgresServer(): Promise<PostgresServer> {
  const configuredUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (configuredUrl) return { rootDatabaseUrl: configuredUrl };
  return startDockerPostgres();
}

async function startDockerPostgres(): Promise<PostgresServer> {
  const containerName = `arb-integration-postgres-${randomUUID().slice(0, 8)}`;
  await execFileAsync(
    "sudo",
    [
      "-n",
      "docker",
      "run",
      "--rm",
      "-d",
      "--name",
      containerName,
      "-e",
      "POSTGRES_PASSWORD=integration",
      "-p",
      "127.0.0.1::5432",
      POSTGRES_IMAGE
    ],
    { timeout: 120_000 }
  );

  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await execFileAsync("sudo", ["-n", "docker", "exec", containerName, "pg_isready", "-U", "postgres"], { timeout: 10_000 });
        break;
      } catch (error) {
        if (attempt === 59) throw error;
        await sleep(1_000);
      }
    }

    const { stdout } = await execFileAsync("sudo", ["-n", "docker", "port", containerName, "5432/tcp"], { timeout: 10_000 });
    const port = stdout.trim().split(":").pop();
    if (!port) throw new Error(`Could not determine mapped Postgres port for ${containerName}`);
    return {
      rootDatabaseUrl: `postgres://postgres:integration@127.0.0.1:${port}/postgres`,
      containerName
    };
  } catch (error) {
    await removeContainer(containerName);
    throw error;
  }
}

async function removeContainer(containerName: string): Promise<void> {
  await execFileAsync("sudo", ["-n", "docker", "rm", "-f", containerName], { timeout: 30_000 }).catch(() => undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
