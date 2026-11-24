import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

class Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(
      this.database,
      this.sql,
      params.map((value) => (value === undefined ? null : value)),
    );
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement().get(...(this.params as never[])) as Record<string, unknown> | undefined;
    const plain = plainRow(row);
    if (!plain) return null;
    if (column) return (plain[column] as T) ?? null;
    return plain as T;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const rows = this.statement().all(...(this.params as never[])) as Record<string, unknown>[];
    return { results: rows.map((row) => plainRow(row) as T), success: true, meta: { changes: 0 } };
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const info = this.statement().run(...(this.params as never[]));
    return {
      success: true,
      meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) },
    };
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

class TestD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): Statement {
    return new Statement(this.database, sql);
  }

  async batch(statements: Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<{ count: number }> {
    this.database.exec(sql);
    return { count: 0 };
  }
}

export function createTestDb(): D1Database {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) database.exec(readFileSync(join(migrationsDir, file), "utf8"));
  return new TestD1(database) as unknown as D1Database;
}

function plainRow(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) copy[key] = typeof value === "bigint" ? Number(value) : value;
  return copy;
}
