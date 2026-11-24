import { chunkByLocalDate, type HealthSyncRequest } from "@fitlogr/shared";
import { api } from "../api";
import { deviceId } from "../session";
import { applyHealthRecords } from "./local";
import { getHealthProvider } from "./runtime";
import type { SQLiteDatabase } from "expo-sqlite";

export interface HealthBackfillResult {
  status: "imported" | "unavailable" | "denied" | "empty";
  days: number;
  records: number;
  message: string;
}

export async function syncHealthHistory(db: SQLiteDatabase, days: number): Promise<HealthBackfillResult> {
  const provider = getHealthProvider();
  const window = Math.min(180, Math.max(1, Math.round(days)));
  if (provider.id !== "healthkit") {
    return {
      status: "unavailable",
      days: window,
      records: 0,
      message: "Apple Health history import runs in the native iOS preview build. Expo Go does not include HealthKit.",
    };
  }
  const permission = await provider.requestPermissions();
  if (permission !== "authorized") {
    return { status: "denied", days: window, records: 0, message: "Apple Health access is off. Enable weight, calories, steps, and workouts." };
  }
  const batch = await provider.syncHistory(window);
  if (batch.records.length === 0) {
    return { status: "empty", days: window, records: 0, message: `No Apple Health samples in the last ${window} days.` };
  }
  const id = await deviceId();
  const chunks = chunkByLocalDate(batch.records, 14).flatMap((chunk) => splitPayload(chunk, 200));
  for (const records of chunks) {
    const body: HealthSyncRequest = { device_id: id, records, checkpoints: [] };
    await api.send("POST", "/health/sync", body);
    await applyHealthRecords(db, records);
  }
  return {
    status: "imported",
    days: window,
    records: batch.records.length,
    message: `Imported ${batch.records.length} Apple Health records from the last ${window} days.`,
  };
}

function splitPayload<T>(records: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < records.length; index += size) chunks.push(records.slice(index, index + size));
  return chunks;
}
