import { healthUnavailableMessage } from "@fitlogr/shared";
import type { HealthPermissionState, HealthProvider, HealthSyncBatch } from "./types";

export class UnsupportedHealthProvider implements HealthProvider {
  readonly id = "unsupported" as const;

  constructor(private readonly message: string) {}

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

  statusMessage(): string {
    return this.message;
  }
}

export function unsupportedProvider(os: string, executionEnvironment?: string | null): UnsupportedHealthProvider {
  return new UnsupportedHealthProvider(healthUnavailableMessage({ os, executionEnvironment }));
}
