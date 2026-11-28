import type { HealthSyncRecord } from "@fitlogr/shared";

export type HealthPermissionState = "unavailable" | "not_determined" | "authorized" | "denied";

export interface HealthSyncBatch {
  records: HealthSyncRecord[];
  nextCheckpoints: Record<string, string | null>;
}

export interface HealthProvider {
  readonly id: "healthkit" | "health_connect" | "unsupported";
  isAvailable(): Promise<boolean>;
  requestPermissions(): Promise<HealthPermissionState>;
  getPermissionState(): Promise<HealthPermissionState>;
  syncIncremental(checkpoints: Record<string, string | null>): Promise<HealthSyncBatch>;
  syncHistory(days: number): Promise<HealthSyncBatch>;
  statusMessage(permission: HealthPermissionState, available: boolean): string;
}

export interface HealthConnection {
  providerId: HealthProvider["id"];
  available: boolean;
  permission: HealthPermissionState;
  connected: boolean;
  message: string;
  lastSyncedAt: string | null;
}
