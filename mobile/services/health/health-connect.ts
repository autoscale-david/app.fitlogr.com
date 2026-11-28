import type { HealthPermissionState, HealthProvider, HealthSyncBatch } from "./types";

/** Typed placeholder for a future Android Health Connect build. No native module is loaded. */
export class HealthConnectProvider implements HealthProvider {
  readonly id = "health_connect" as const;

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async requestPermissions(): Promise<HealthPermissionState> {
    return "unavailable";
  }

  async getPermissionState(): Promise<HealthPermissionState> {
    return "unavailable";
  }

  async syncIncremental(checkpoints: Record<string, string | null>): Promise<HealthSyncBatch> {
    return { records: [], nextCheckpoints: checkpoints };
  }

  async syncHistory(): Promise<HealthSyncBatch> {
    return { records: [], nextCheckpoints: {} };
  }

  statusMessage(): string {
    return "Android Health Connect support is coming in a later build.";
  }
}
