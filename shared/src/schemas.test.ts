import { describe, expect, it } from "vitest";
import {
  AuthStartRequestSchema,
  MealWriteSchema,
  SettingsUpdateSchema,
  SyncChangesResponseSchema,
  WeightWriteSchema,
} from "./schemas/index";

describe("stage 2 API schemas", () => {
  it("accepts a native and an Expo Go auth start", () => {
    expect(
      AuthStartRequestSchema.safeParse({
        redirect_uri: "fitlogr://auth/callback",
        client_challenge: "a".repeat(43),
        device: { platform: "ios" },
      }).success,
    ).toBe(true);
    expect(
      AuthStartRequestSchema.safeParse({
        redirect_uri: "exp://10.0.0.8:8081/--/auth/callback",
        client_challenge: "abc",
      }).success,
    ).toBe(false);
  });

  it("rejects meal writes that try to skip items", () => {
    const parsed = MealWriteSchema.safeParse({
      name: "Lunch",
      eaten_at: "2026-11-23T20:00:00.000Z",
      local_date: "2026-11-23",
      timezone: "America/Los_Angeles",
      items: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts weight, settings, and a sync page", () => {
    expect(
      WeightWriteSchema.safeParse({
        weight_kg: 79.2,
        recorded_at: "2026-11-23T15:00:00.000Z",
        local_date: "2026-11-23",
        timezone: "America/Los_Angeles",
      }).success,
    ).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ daily_calorie_target_kcal: 1800 }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ expected_updated_at: "2026-11-23T15:00:00.000Z" }).success).toBe(false);
    expect(
      SyncChangesResponseSchema.safeParse({
        cursor: "opaque",
        has_more: false,
        settings: null,
        meals: [],
        health_records: [],
      }).success,
    ).toBe(true);
  });
});
