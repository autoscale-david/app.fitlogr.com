import { describe, expect, it } from "vitest";
import {
  APPLE_HEALTH_NATIVE_BUILD_MESSAGE,
  EXPO_GO_EXECUTION_ENVIRONMENT,
  HealthSyncRequestSchema,
  canonicalizeHealthRecord,
  dailyCalorieExpenditure,
  healthUnavailableMessage,
  resolveHealthProviderKind,
} from "./health";

const base = {
  source_platform: "healthkit" as const,
  source_app_id: "com.apple.health",
  source_device_name: "Apple Watch",
  start_time: "2026-11-24T03:30:00.000Z",
  end_time: "2026-11-24T03:30:00.000Z",
  local_date: "2026-11-23",
  timezone: "America/Los_Angeles",
};

describe("daily calorie expenditure", () => {
  it("does not add workout calories that are already inside the daily active total", () => {
    const energy = dailyCalorieExpenditure({
      activeCaloriesKcal: 500,
      restingCaloriesKcal: 1400,
      workoutCaloriesKcal: 300,
    });
    expect(energy).toMatchObject({
      activeCaloriesKcal: 500,
      restingCaloriesKcal: 1400,
      workoutCaloriesKcal: 300,
      totalBurnedKcal: 1900,
      activeSource: "aggregate",
      workoutsCountedInTotal: false,
    });
  });

  it("keeps an explicit zero active total from being replaced by workouts", () => {
    const energy = dailyCalorieExpenditure({
      activeCaloriesKcal: 0,
      restingCaloriesKcal: 1500,
      workoutCaloriesKcal: 280,
    });
    expect(energy.totalBurnedKcal).toBe(1500);
    expect(energy.activeSource).toBe("aggregate");
    expect(energy.workoutsCountedInTotal).toBe(false);
  });

  it("falls back to workout calories when no daily active-energy record exists", () => {
    const energy = dailyCalorieExpenditure({
      activeCaloriesKcal: null,
      restingCaloriesKcal: 1500,
      workoutCaloriesKcal: 280,
    });
    expect(energy).toMatchObject({
      activeCaloriesKcal: 280,
      restingCaloriesKcal: 1500,
      totalBurnedKcal: 1780,
      activeSource: "workouts",
      workoutsCountedInTotal: true,
    });
  });

  it("does not invent active burn when neither an aggregate nor workouts exist", () => {
    expect(dailyCalorieExpenditure({ activeCaloriesKcal: null, restingCaloriesKcal: 1400, workoutCaloriesKcal: 0 })).toMatchObject({
      activeCaloriesKcal: 0,
      totalBurnedKcal: 1400,
      activeSource: "none",
    });
  });
});

describe("health sync records", () => {
  it("preserves source identity and converts pounds to kilograms", () => {
    const canonical = canonicalizeHealthRecord({
      ...base,
      record_type: "weight",
      external_id: "hk-weight-1",
      value: 174.2,
      unit: "lb",
    });
    expect(canonical.platform).toBe("healthkit");
    expect(canonical.source_record_id).toBe("hk-weight-1");
    expect(canonical.unit).toBe("kg");
    expect(canonical.value_num).toBeCloseTo(79.016, 2);
    expect(canonical.metadata).toMatchObject({ original_unit: "lb", original_value: 174.2 });
    expect(canonical.local_date).toBe("2026-11-23");
  });

  it("stores heart rate summaries under the database record type", () => {
    const canonical = canonicalizeHealthRecord({
      ...base,
      record_type: "heart_rate",
      external_id: "agg:hr:2026-11-23",
      value: 72,
      unit: "count/min",
      metadata: { min_bpm: 58, max_bpm: 141 },
    });
    expect(canonical.record_type).toBe("heart_rate_summary");
    expect(canonical.unit).toBe("bpm");
    expect(canonical.metadata).toMatchObject({ min_bpm: 58, max_bpm: 141 });
  });

  it("rejects a batch larger than 250 records", () => {
    const record = {
      ...base,
      record_type: "steps" as const,
      external_id: "agg:steps:2026-11-23",
      value: 1000,
      unit: "count",
    };
    const parsed = HealthSyncRequestSchema.safeParse({
      device_id: "device-health-1",
      records: Array.from({ length: 251 }, (_, index) => ({ ...record, external_id: `steps-${index}` })),
      checkpoints: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("HealthProvider Expo Go fallback", () => {
  it("never selects HealthKit inside Expo Go on iOS", () => {
    expect(
      resolveHealthProviderKind({
        os: "ios",
        executionEnvironment: EXPO_GO_EXECUTION_ENVIRONMENT,
        nativeModuleLoaded: true,
      }),
    ).toBe("unsupported");
    expect(healthUnavailableMessage({ os: "ios", executionEnvironment: EXPO_GO_EXECUTION_ENVIRONMENT })).toBe(
      APPLE_HEALTH_NATIVE_BUILD_MESSAGE,
    );
  });

  it("selects HealthKit only for a native iOS runtime with the module loaded", () => {
    expect(resolveHealthProviderKind({ os: "ios", executionEnvironment: "bare", nativeModuleLoaded: true })).toBe("healthkit");
    expect(resolveHealthProviderKind({ os: "ios", executionEnvironment: "standalone", nativeModuleLoaded: false })).toBe(
      "unsupported",
    );
  });

  it("selects the Health Connect stub on Android without loading HealthKit", () => {
    expect(
      resolveHealthProviderKind({
        os: "android",
        executionEnvironment: EXPO_GO_EXECUTION_ENVIRONMENT,
        nativeModuleLoaded: false,
      }),
    ).toBe("health_connect");
    expect(resolveHealthProviderKind({ os: "web", executionEnvironment: null, nativeModuleLoaded: false })).toBe("unsupported");
  });
});
