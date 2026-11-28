import { z } from "zod";
import { HealthPlatformSchema } from "./schemas/health";
import { MealSchema } from "./schemas/meals";

/** Expo Go's execution environment. Native HealthKit must not load there. */
export const EXPO_GO_EXECUTION_ENVIRONMENT = "storeClient";

export const APPLE_HEALTH_NATIVE_BUILD_MESSAGE = "Apple Health requires a native iPhone EAS build";

export const NormalizedHealthRecordTypeSchema = z.enum([
  "weight",
  "active_calories",
  "resting_calories",
  "workout",
  "steps",
  "heart_rate",
  "resting_heart_rate",
]);
export type NormalizedHealthRecordType = z.infer<typeof NormalizedHealthRecordTypeSchema>;

/** Record types stored in `health_records`. `heart_rate` is persisted as `heart_rate_summary`. */
export const StoredHealthRecordTypeSchema = z.enum([
  "weight",
  "active_calories",
  "resting_calories",
  "workout",
  "steps",
  "heart_rate_summary",
  "resting_heart_rate",
]);
export type StoredHealthRecordType = z.infer<typeof StoredHealthRecordTypeSchema>;

export const HealthRecordMetadataSchema = z.object({
  activity_type: z.string().min(1).max(80).optional(),
  workout_kcal: z.number().min(0).max(20000).optional(),
  distance_m: z.number().min(0).max(1_000_000).nullable().optional(),
  avg_hr: z.number().min(0).max(300).nullable().optional(),
  min_bpm: z.number().min(0).max(300).nullable().optional(),
  max_bpm: z.number().min(0).max(300).nullable().optional(),
  original_value: z.number().finite().optional(),
  original_unit: z.string().min(1).max(20).optional(),
});
export type HealthRecordMetadata = z.infer<typeof HealthRecordMetadataSchema>;

const DeviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);

export const HealthSyncRecordSchema = z
  .object({
    record_type: NormalizedHealthRecordTypeSchema,
    source_platform: HealthPlatformSchema,
    external_id: z.string().min(1).max(200),
    source_app_id: z.string().min(1).max(200).nullable().optional(),
    source_device_name: z.string().min(1).max(200).nullable().optional(),
    start_time: z.iso.datetime(),
    end_time: z.iso.datetime(),
    local_date: z.iso.date(),
    timezone: z.string().min(1).max(80),
    value: z.number().finite(),
    unit: z.string().min(1).max(20),
    metadata: HealthRecordMetadataSchema.nullable().optional(),
    deleted: z.boolean().optional(),
  })
  .superRefine((record, ctx) => {
    if (record.deleted) return;
    const unit = record.unit.toLowerCase();
    const allowed = allowedUnits(record.record_type);
    if (!allowed.includes(unit)) {
      ctx.addIssue({ code: "custom", message: `${record.record_type} does not accept unit ${record.unit}`, path: ["unit"] });
    }
  });
export type HealthSyncRecord = z.infer<typeof HealthSyncRecordSchema>;

export const HealthCheckpointInputSchema = z.object({
  source: z.string().min(1).max(120),
  cursor: z.string().max(8000).nullable(),
});
export type HealthCheckpointInput = z.infer<typeof HealthCheckpointInputSchema>;

export const HealthCheckpointSchema = HealthCheckpointInputSchema.extend({
  device_id: DeviceIdSchema,
  synced_at: z.iso.datetime(),
});
export type HealthCheckpoint = z.infer<typeof HealthCheckpointSchema>;

export const HealthSyncRequestSchema = z.object({
  device_id: DeviceIdSchema,
  records: z.array(HealthSyncRecordSchema).max(250),
  checkpoints: z.array(HealthCheckpointInputSchema).max(30),
});
export type HealthSyncRequest = z.infer<typeof HealthSyncRequestSchema>;

export const HealthSyncResponseSchema = z.object({
  upserted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  dates: z.array(z.iso.date()),
});
export type HealthSyncResponse = z.infer<typeof HealthSyncResponseSchema>;

export const DayWorkoutSchema = z.object({
  id: z.string(),
  external_id: z.string(),
  activity_type: z.string(),
  name: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  duration_min: z.number().int(),
  calories_kcal: z.number(),
  source: z.string(),
  source_app_id: z.string().nullable(),
});
export type DayWorkout = z.infer<typeof DayWorkoutSchema>;

export const DayWeightSchema = z.object({
  weight_kg: z.number(),
  recorded_at: z.string(),
  local_date: z.string(),
  source_platform: HealthPlatformSchema,
});
export type DayWeight = z.infer<typeof DayWeightSchema>;

export const DayHeartRateSchema = z.object({
  avg_bpm: z.number().nullable(),
  min_bpm: z.number().nullable(),
  max_bpm: z.number().nullable(),
  resting_bpm: z.number().nullable(),
});
export type DayHeartRate = z.infer<typeof DayHeartRateSchema>;

export const ActiveEnergySourceSchema = z.enum(["aggregate", "workouts", "none"]);
export type ActiveEnergySource = z.infer<typeof ActiveEnergySourceSchema>;

export const DaySummarySchema = z.object({
  calories_in_kcal: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  meal_count: z.number().int(),
  active_calories_kcal: z.number(),
  resting_calories_kcal: z.number(),
  workout_calories_kcal: z.number(),
  total_calories_out_kcal: z.number(),
  calorie_balance_kcal: z.number(),
  calories_remaining_kcal: z.number().nullable(),
  steps: z.number().int(),
  workout_count: z.number().int(),
  workout_minutes: z.number().int(),
  weight_kg: z.number().nullable(),
  resting_heart_rate_bpm: z.number().nullable(),
  avg_heart_rate_bpm: z.number().nullable(),
  active_energy_source: ActiveEnergySourceSchema,
});
export type DaySummary = z.infer<typeof DaySummarySchema>;

export const DayResponseSchema = z.object({
  date: z.iso.date(),
  timezone: z.string(),
  summary: DaySummarySchema,
  meals: z.array(MealSchema),
  workouts: z.array(DayWorkoutSchema),
  weight: DayWeightSchema.nullable(),
  heart_rate: DayHeartRateSchema,
});
export type DayResponse = z.infer<typeof DayResponseSchema>;

export interface CanonicalHealthRecord {
  platform: z.infer<typeof HealthPlatformSchema>;
  record_type: StoredHealthRecordType;
  source_record_id: string;
  source_app_id: string | null;
  source_device_name: string | null;
  start_time: string;
  end_time: string;
  local_date: string;
  timezone: string;
  value_num: number;
  unit: string;
  metadata: HealthRecordMetadata | null;
  deleted: boolean;
}

export class HealthRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthRecordError";
  }
}

const LB_PER_KG = 2.2046226218;
const KJ_PER_KCAL = 4.184;

export type HealthProviderKind = "healthkit" | "health_connect" | "unsupported";

/**
 * Expo Go (storeClient) on iOS must resolve to `unsupported` even when a
 * caller claims the native module loaded. That keeps the HealthKit require
 * off the startup path.
 */
export function resolveHealthProviderKind(input: {
  os: string;
  executionEnvironment?: string | null;
  nativeModuleLoaded: boolean;
}): HealthProviderKind {
  if (input.os === "ios" && input.executionEnvironment === EXPO_GO_EXECUTION_ENVIRONMENT) return "unsupported";
  if (input.os === "ios") return input.nativeModuleLoaded ? "healthkit" : "unsupported";
  if (input.os === "android") return "health_connect";
  return "unsupported";
}

export function healthUnavailableMessage(input: { os: string; executionEnvironment?: string | null }): string {
  if (input.os === "ios") return APPLE_HEALTH_NATIVE_BUILD_MESSAGE;
  if (input.os === "android") return "Android Health Connect support is coming in a later build.";
  return "Apple Health is available on iPhone.";
}

export interface DailyEnergyInput {
  /** Platform daily active-energy total. `null` means no aggregate was reported. */
  activeCaloriesKcal: number | null;
  restingCaloriesKcal: number | null;
  /** Sum of per-workout calories, used for workout cards and as the active fallback. */
  workoutCaloriesKcal: number;
}

export interface DailyEnergy {
  activeCaloriesKcal: number;
  restingCaloriesKcal: number;
  workoutCaloriesKcal: number;
  totalBurnedKcal: number;
  activeSource: ActiveEnergySource;
  /** True only when workout calories were used because no daily active-energy aggregate exists. */
  workoutsCountedInTotal: boolean;
}

/**
 * Total burned is active + resting. Workout calories are already inside a
 * platform daily active-energy total, so they are not added again. When that
 * aggregate is missing, workout calories stand in for active burn.
 */
export function dailyCalorieExpenditure(input: DailyEnergyInput): DailyEnergy {
  const resting = roundKcal(Math.max(0, input.restingCaloriesKcal ?? 0));
  const workouts = roundKcal(Math.max(0, input.workoutCaloriesKcal));
  if (input.activeCaloriesKcal != null) {
    const active = roundKcal(Math.max(0, input.activeCaloriesKcal));
    return {
      activeCaloriesKcal: active,
      restingCaloriesKcal: resting,
      workoutCaloriesKcal: workouts,
      totalBurnedKcal: roundKcal(active + resting),
      activeSource: "aggregate",
      workoutsCountedInTotal: false,
    };
  }
  if (workouts > 0) {
    return {
      activeCaloriesKcal: workouts,
      restingCaloriesKcal: resting,
      workoutCaloriesKcal: workouts,
      totalBurnedKcal: roundKcal(workouts + resting),
      activeSource: "workouts",
      workoutsCountedInTotal: true,
    };
  }
  return {
    activeCaloriesKcal: 0,
    restingCaloriesKcal: resting,
    workoutCaloriesKcal: 0,
    totalBurnedKcal: resting,
    activeSource: "none",
    workoutsCountedInTotal: false,
  };
}

export function canonicalizeHealthRecord(record: HealthSyncRecord): CanonicalHealthRecord {
  const metadata: HealthRecordMetadata = { ...(record.metadata ?? {}) };
  let value = record.value;
  let unit = record.unit.toLowerCase();
  if (!record.deleted) {
    const converted = convertUnits(record.record_type, value, unit);
    if (converted.unit !== unit) {
      metadata.original_value = value;
      metadata.original_unit = record.unit;
    }
    value = converted.value;
    unit = converted.unit;
    assertRange(record.record_type, value);
  } else {
    value = 0;
    unit = defaultUnit(record.record_type);
  }
  return {
    platform: record.source_platform,
    record_type: record.record_type === "heart_rate" ? "heart_rate_summary" : record.record_type,
    source_record_id: record.external_id,
    source_app_id: record.source_app_id ?? null,
    source_device_name: record.source_device_name ?? null,
    start_time: record.start_time,
    end_time: record.end_time,
    local_date: record.local_date,
    timezone: record.timezone,
    value_num: value,
    unit,
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
    deleted: record.deleted === true,
  };
}

export function workoutDisplayName(activityType: string): string {
  const spaced = activityType.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  if (!spaced) return "Workout";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function allowedUnits(type: NormalizedHealthRecordType): string[] {
  switch (type) {
    case "weight":
      return ["kg", "lb"];
    case "active_calories":
    case "resting_calories":
      return ["kcal", "kj", "cal"];
    case "steps":
      return ["count"];
    case "heart_rate":
    case "resting_heart_rate":
      return ["bpm", "count/min"];
    case "workout":
      return ["sec", "s", "min"];
    default:
      return [];
  }
}

function defaultUnit(type: NormalizedHealthRecordType): string {
  switch (type) {
    case "weight":
      return "kg";
    case "active_calories":
    case "resting_calories":
      return "kcal";
    case "steps":
      return "count";
    case "heart_rate":
    case "resting_heart_rate":
      return "bpm";
    case "workout":
      return "sec";
    default:
      return "count";
  }
}

function convertUnits(type: NormalizedHealthRecordType, value: number, unit: string): { value: number; unit: string } {
  if (type === "weight" && unit === "lb") return { value: roundTo(value / LB_PER_KG, 3), unit: "kg" };
  if (type === "weight") return { value: roundTo(value, 3), unit: "kg" };
  if ((type === "active_calories" || type === "resting_calories") && unit === "kj") {
    return { value: roundTo(value / KJ_PER_KCAL, 1), unit: "kcal" };
  }
  if ((type === "active_calories" || type === "resting_calories") && unit === "cal") {
    return { value: roundTo(value / 1000, 1), unit: "kcal" };
  }
  if (type === "active_calories" || type === "resting_calories") return { value: roundTo(value, 1), unit: "kcal" };
  if (type === "steps") return { value: Math.round(value), unit: "count" };
  if (type === "heart_rate" || type === "resting_heart_rate") return { value: roundTo(value, 1), unit: "bpm" };
  if (type === "workout" && unit === "min") return { value: Math.round(value * 60), unit: "sec" };
  if (type === "workout") return { value: Math.round(value), unit: "sec" };
  return { value, unit };
}

function assertRange(type: NormalizedHealthRecordType, value: number): void {
  const ranges: Record<NormalizedHealthRecordType, [number, number]> = {
    weight: [1, 500],
    active_calories: [0, 20000],
    resting_calories: [0, 20000],
    workout: [0, 86400],
    steps: [0, 200000],
    heart_rate: [0, 300],
    resting_heart_rate: [0, 300],
  };
  const [min, max] = ranges[type];
  if (value < min || value > max) throw new HealthRecordError(`${type} value is out of range`);
}

function roundKcal(value: number): number {
  return Math.round(value);
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
