import type { SQLiteDatabase } from "expo-sqlite";
import * as Crypto from "expo-crypto";
import type { HealthSyncRecord, HealthSyncRequest } from "@fitlogr/shared";
import { randomUuid } from "../encoding";
import { readSetting, writeSetting } from "../db";
import { deviceId } from "../session";
import { applyHealthRecords } from "./local";
import { getHealthProvider } from "./runtime";
import type { HealthConnection } from "./types";

const FOREGROUND_GAP_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 200;

export async function readHealthConnection(db: SQLiteDatabase): Promise<HealthConnection> {
  const provider = getHealthProvider();
  const available = await provider.isAvailable();
  const permission = await provider.getPermissionState();
  return {
    providerId: provider.id,
    available,
    permission,
    connected: provider.id === "healthkit" && available && permission === "authorized",
    message: provider.statusMessage(permission, available),
    lastSyncedAt: await readSetting(db, "health_synced_at"),
  };
}

export async function syncAppleHealth(db: SQLiteDatabase, options: { force: boolean; upload: boolean }): Promise<HealthConnection> {
  const provider = getHealthProvider();
  if (provider.id !== "healthkit") return readHealthConnection(db);
  const last = await readSetting(db, "health_synced_at");
  if (!options.force && last && Date.now() - Date.parse(last) < FOREGROUND_GAP_MS) return readHealthConnection(db);
  const permission = await provider.getPermissionState();
  if (permission !== "authorized") return readHealthConnection(db);

  const stored = await db.getAllAsync<{ source: string; cursor_value: string | null }>("SELECT source, cursor_value FROM health_checkpoints");
  const checkpoints: Record<string, string | null> = {};
  for (const row of stored) checkpoints[row.source] = row.cursor_value;
  const batch = await provider.syncIncremental(checkpoints);
  await applyHealthRecords(db, batch.records);
  if (options.upload && batch.records.length > 0) await enqueueHealthSync(db, await deviceId(), batch.records, batch.nextCheckpoints);
  else if (options.upload) await enqueueCheckpoints(db, await deviceId(), batch.nextCheckpoints);
  await saveCheckpoints(db, batch.nextCheckpoints);
  await writeSetting(db, "health_synced_at", new Date().toISOString());
  return readHealthConnection(db);
}

async function saveCheckpoints(db: SQLiteDatabase, checkpoints: Record<string, string | null>): Promise<void> {
  const stamp = new Date().toISOString();
  for (const [source, cursor] of Object.entries(checkpoints)) {
    await db.runAsync(
      `INSERT INTO health_checkpoints (source, cursor_value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET cursor_value = excluded.cursor_value, updated_at = excluded.updated_at`,
      source,
      cursor,
      stamp,
    );
  }
}

async function enqueueCheckpoints(db: SQLiteDatabase, id: string, checkpoints: Record<string, string | null>): Promise<void> {
  const pending = Object.entries(checkpoints).filter(([, cursor]) => cursor);
  if (pending.length === 0) return;
  await enqueueHealthSync(db, id, [], checkpoints);
}

async function enqueueHealthSync(
  db: SQLiteDatabase,
  id: string,
  records: HealthSyncRecord[],
  checkpoints: Record<string, string | null>,
): Promise<void> {
  const existing = await db.getAllAsync<{ payload_json: string }>(
    "SELECT payload_json FROM sync_outbox WHERE entity_type = ? ORDER BY created_at",
    "health_sync",
  );
  const merged = new Map<string, HealthSyncRecord>();
  const cursors = new Map<string, string | null>();
  for (const row of existing) {
    const payload = JSON.parse(row.payload_json) as HealthSyncRequest;
    for (const record of payload.records) merged.set(`${record.record_type}:${record.external_id}`, record);
    for (const checkpoint of payload.checkpoints) cursors.set(checkpoint.source, checkpoint.cursor);
  }
  for (const record of records) merged.set(`${record.record_type}:${record.external_id}`, record);
  for (const [source, cursor] of Object.entries(checkpoints)) cursors.set(source, cursor);
  await db.runAsync("DELETE FROM sync_outbox WHERE entity_type = ?", "health_sync");
  const all = [...merged.values()];
  const checkpointList = [...cursors.entries()].map(([source, cursor]) => ({ source, cursor }));
  const chunks = all.length === 0 ? [[]] : chunk(all, BATCH_LIMIT);
  for (let index = 0; index < chunks.length; index += 1) {
    const body: HealthSyncRequest = {
      device_id: id,
      records: chunks[index] ?? [],
      checkpoints: index === chunks.length - 1 ? checkpointList : [],
    };
    if (body.records.length === 0 && body.checkpoints.length === 0) continue;
    const rowId = randomUuid(await Crypto.getRandomBytesAsync(16));
    await db.runAsync(
      `INSERT INTO sync_outbox (id, entity_type, entity_id, method, path, payload_json, retry_count, created_at)
       VALUES (?, 'health_sync', ?, 'POST', '/health/sync', ?, 0, ?)`,
      rowId,
      `health-${index}`,
      JSON.stringify(body),
      new Date().toISOString(),
    );
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}
