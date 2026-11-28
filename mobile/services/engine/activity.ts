import type { SQLiteDatabase } from "expo-sqlite";
import type { PipelineCounts } from "./pipeline";

export interface PassLogEntry {
  ranAt: string;
  reason: string;
  durationMs: number;
  counts: PipelineCounts | null;
  error: string | null;
}

export async function recordPass(
  db: SQLiteDatabase,
  entry: { reason: string; durationMs: number; counts: PipelineCounts | null; error: string | null },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO pass_log (ran_at, reason, duration_ms, counts_json, error) VALUES (?, ?, ?, ?, ?)`,
    new Date().toISOString(),
    entry.reason,
    Math.max(0, Math.round(entry.durationMs)),
    entry.counts ? JSON.stringify(entry.counts) : null,
    entry.error,
  );
  await db.runAsync(`DELETE FROM pass_log WHERE id NOT IN (SELECT id FROM pass_log ORDER BY id DESC LIMIT 50)`);
}

export async function listPasses(db: SQLiteDatabase): Promise<PassLogEntry[]> {
  const rows = await db.getAllAsync<{ ran_at: string; reason: string; duration_ms: number; counts_json: string | null; error: string | null }>(
    `SELECT ran_at, reason, duration_ms, counts_json, error FROM pass_log ORDER BY id DESC LIMIT 50`,
  );
  return rows.map((row) => ({
    ranAt: row.ran_at,
    reason: row.reason,
    durationMs: row.duration_ms,
    counts: parseCounts(row.counts_json),
    error: row.error,
  }));
}

function parseCounts(raw: string | null): PipelineCounts | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PipelineCounts;
  } catch {
    return null;
  }
}
