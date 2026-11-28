import Constants, { ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";
import type { HealthSyncRecord } from "@fitlogr/shared";
import { deviceTimeZone, localDateISO } from "../dates";
import type { HealthPermissionState, HealthProvider, HealthSyncBatch } from "./types";

const READ_TYPES = [
  "HKQuantityTypeIdentifierBodyMass",
  "HKQuantityTypeIdentifierActiveEnergyBurned",
  "HKQuantityTypeIdentifierBasalEnergyBurned",
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierHeartRate",
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKWorkoutTypeIdentifier",
] as const;

const SOURCE = {
  weight: "healthkit:weight",
  active: "healthkit:active_calories",
  resting: "healthkit:resting_calories",
  workout: "healthkit:workout",
  steps: "healthkit:steps",
  heart: "healthkit:heart_rate",
  restingHeart: "healthkit:resting_heart_rate",
} as const;

interface Quantity {
  readonly unit?: string;
  readonly quantity: number;
}

interface StatisticsBucket {
  readonly sumQuantity?: Quantity;
  readonly averageQuantity?: Quantity;
  readonly minimumQuantity?: Quantity;
  readonly maximumQuantity?: Quantity;
  readonly mostRecentQuantity?: Quantity;
  readonly startDate?: Date | string;
  readonly endDate?: Date | string;
  readonly sources?: readonly { name?: string; bundleIdentifier?: string }[];
}

interface HealthSample {
  readonly uuid: string;
  readonly startDate: Date | string;
  readonly endDate: Date | string;
  readonly quantity?: number;
  readonly unit?: string;
  readonly sourceRevision?: { source?: { name?: string; bundleIdentifier?: string } };
  readonly device?: { name?: string };
}

interface WorkoutSample extends HealthSample {
  readonly workoutActivityType?: number | string;
  readonly duration?: Quantity;
  readonly totalEnergyBurned?: Quantity;
  readonly totalDistance?: Quantity;
  toJSON?: () => WorkoutSample;
}

interface AnchorPage<T> {
  readonly samples?: readonly T[];
  readonly workouts?: readonly T[];
  readonly deletedSamples?: readonly { uuid: string }[];
  readonly newAnchor?: string;
}

export interface HealthKitApi {
  isHealthDataAvailable: () => boolean;
  requestAuthorization: (request: { toRead: readonly string[] }) => Promise<boolean>;
  getRequestStatusForAuthorization: (request: { toRead: readonly string[] }) => Promise<number>;
  AuthorizationRequestStatus: { unknown: number; shouldRequest: number; unnecessary: number };
  queryQuantitySamplesWithAnchor: (
    identifier: string,
    options: {
      limit: number;
      unit?: string;
      anchor?: string;
      filter?: { date?: { startDate?: Date; endDate?: Date } };
    },
  ) => Promise<AnchorPage<HealthSample>>;
  queryStatisticsCollectionForQuantity: (
    identifier: string,
    statistics: readonly string[],
    anchorDate: Date,
    interval: { day: number },
    options?: { unit?: string; filter?: { date?: { startDate?: Date; endDate?: Date } } },
  ) => Promise<readonly StatisticsBucket[]>;
  queryWorkoutSamplesWithAnchor: (options: {
    limit: number;
    anchor?: string;
    filter?: { date?: { startDate?: Date } };
  }) => Promise<AnchorPage<WorkoutSample>>;
  WorkoutActivityType?: Record<number, string>;
}

declare const require: (moduleName: string) => unknown;

/**
 * Expo Go never reaches this require. A static string keeps the native module
 * in EAS bundles without evaluating it during Expo Go startup.
 */
export function loadHealthKitModule(): HealthKitApi | null {
  if (Platform.OS !== "ios") return null;
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return null;
  try {
    return require("@kingstinct/react-native-healthkit") as HealthKitApi;
  } catch {
    return null;
  }
}

export class HealthKitProvider implements HealthProvider {
  readonly id = "healthkit" as const;

  constructor(private readonly health: HealthKitApi) {}

  async isAvailable(): Promise<boolean> {
    try {
      return this.health.isHealthDataAvailable();
    } catch {
      return false;
    }
  }

  async requestPermissions(): Promise<HealthPermissionState> {
    if (!(await this.isAvailable())) return "unavailable";
    try {
      await this.health.requestAuthorization({ toRead: READ_TYPES });
    } catch {
      return "denied";
    }
    return this.getPermissionState();
  }

  async getPermissionState(): Promise<HealthPermissionState> {
    if (!(await this.isAvailable())) return "unavailable";
    try {
      const status = await this.health.getRequestStatusForAuthorization({ toRead: READ_TYPES });
      if (status === this.health.AuthorizationRequestStatus.unnecessary) return "authorized";
      if (status === this.health.AuthorizationRequestStatus.shouldRequest) return "not_determined";
      return "not_determined";
    } catch {
      return "denied";
    }
  }

  async syncIncremental(checkpoints: Record<string, string | null>): Promise<HealthSyncBatch> {
    const permission = await this.getPermissionState();
    if (permission !== "authorized") return { records: [], nextCheckpoints: checkpoints };
    const now = new Date();
    const records: HealthSyncRecord[] = [];
    const next = { ...checkpoints };

    const weightAnchor = await this.readSamples(
      "HKQuantityTypeIdentifierBodyMass",
      "kg",
      checkpoints[SOURCE.weight] ?? null,
      now,
    );
    records.push(...weightAnchor.records.map((sample) => this.quantityRecord("weight", sample, "kg")));
    records.push(...deleted("weight", weightAnchor.deleted));
    next[SOURCE.weight] = weightAnchor.anchor;

    records.push(
      ...this.dailyBuckets(
        await this.statistics("HKQuantityTypeIdentifierActiveEnergyBurned", ["cumulativeSum"], "kcal", checkpoints[SOURCE.active] ?? null, now),
        "active_calories",
        "agg:active_kcal:",
        "sum",
      ),
    );
    next[SOURCE.active] = now.toISOString();
    records.push(
      ...this.dailyBuckets(
        await this.statistics("HKQuantityTypeIdentifierBasalEnergyBurned", ["cumulativeSum"], "kcal", checkpoints[SOURCE.resting] ?? null, now),
        "resting_calories",
        "agg:resting_kcal:",
        "sum",
      ),
    );
    next[SOURCE.resting] = now.toISOString();
    records.push(
      ...this.dailyBuckets(
        await this.statistics("HKQuantityTypeIdentifierStepCount", ["cumulativeSum"], "count", checkpoints[SOURCE.steps] ?? null, now),
        "steps",
        "agg:steps:",
        "sum",
      ),
    );
    next[SOURCE.steps] = now.toISOString();
    records.push(
      ...this.dailyBuckets(
        await this.statistics(
          "HKQuantityTypeIdentifierHeartRate",
          ["discreteAverage", "discreteMin", "discreteMax"],
          "count/min",
          checkpoints[SOURCE.heart] ?? null,
          now,
        ),
        "heart_rate",
        "agg:hr:",
        "average",
      ),
    );
    next[SOURCE.heart] = now.toISOString();
    records.push(
      ...this.dailyBuckets(
        await this.statistics(
          "HKQuantityTypeIdentifierRestingHeartRate",
          ["mostRecent"],
          "count/min",
          checkpoints[SOURCE.restingHeart] ?? null,
          now,
        ),
        "resting_heart_rate",
        "agg:rhr:",
        "recent",
      ),
    );
    next[SOURCE.restingHeart] = now.toISOString();

    const workouts = await this.readWorkouts(checkpoints[SOURCE.workout] ?? null, now);
    records.push(...workouts.records);
    records.push(...deleted("workout", workouts.deleted));
    next[SOURCE.workout] = workouts.anchor;

    return { records, nextCheckpoints: next };
  }

  async syncHistory(days: number): Promise<HealthSyncBatch> {
    const permission = await this.getPermissionState();
    if (permission !== "authorized") return { records: [], nextCheckpoints: {} };
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start.setDate(start.getDate() - (Math.max(1, days) - 1));
    const end = tomorrow(now);
    const records: HealthSyncRecord[] = [];
    const weight = await this.health.queryQuantitySamplesWithAnchor("HKQuantityTypeIdentifierBodyMass", {
      limit: 0,
      unit: "kg",
      filter: { date: { startDate: start, endDate: end } },
    });
    records.push(...(weight.samples ?? []).map((sample) => this.quantityRecord("weight", sample, "kg")));
    records.push(
      ...this.dailyBuckets(
        await this.rangeStatistics("HKQuantityTypeIdentifierActiveEnergyBurned", ["cumulativeSum"], "kcal", start, end),
        "active_calories",
        "agg:active_kcal:",
        "sum",
      ),
    );
    records.push(
      ...this.dailyBuckets(
        await this.rangeStatistics("HKQuantityTypeIdentifierBasalEnergyBurned", ["cumulativeSum"], "kcal", start, end),
        "resting_calories",
        "agg:resting_kcal:",
        "sum",
      ),
    );
    records.push(
      ...this.dailyBuckets(
        await this.rangeStatistics("HKQuantityTypeIdentifierStepCount", ["cumulativeSum"], "count", start, end),
        "steps",
        "agg:steps:",
        "sum",
      ),
    );
    const workouts = await this.health.queryWorkoutSamplesWithAnchor({
      limit: 0,
      filter: { date: { startDate: start } },
    });
    const samples = (workouts.workouts ?? []).map((workout) => (typeof workout.toJSON === "function" ? workout.toJSON() : workout));
    records.push(...samples.filter((workout) => asDate(workout.startDate) >= start).map((workout) => this.workoutRecord(workout)));
    return { records, nextCheckpoints: {} };
  }

  statusMessage(permission: HealthPermissionState, available: boolean): string {
    if (!available || permission === "unavailable") return "Apple Health is not available on this device.";
    if (permission === "authorized") return "Apple Health is connected.";
    if (permission === "denied") return "Apple Health access is off. Enable it in the iOS Settings app.";
    return "Connect Apple Health to sync workouts, calories, and weight.";
  }

  private async readSamples(identifier: string, unit: string, anchor: string | null, now: Date) {
    const page = await this.health.queryQuantitySamplesWithAnchor(identifier, {
      limit: 0,
      unit,
      ...(anchor ? { anchor } : { filter: { date: { startDate: windowStart(false, now), endDate: tomorrow(now) } } }),
    });
    return {
      records: page.samples ?? [],
      deleted: (page.deletedSamples ?? []).map((sample) => sample.uuid),
      anchor: page.newAnchor ?? anchor,
    };
  }

  private async rangeStatistics(
    identifier: string,
    statistics: readonly string[],
    unit: string,
    start: Date,
    end: Date,
  ): Promise<readonly StatisticsBucket[]> {
    return this.health.queryStatisticsCollectionForQuantity(identifier, statistics, start, { day: 1 }, {
      unit,
      filter: { date: { startDate: start, endDate: end } },
    });
  }

  private async statistics(
    identifier: string,
    statistics: readonly string[],
    unit: string,
    checkpoint: string | null,
    now: Date,
  ): Promise<readonly StatisticsBucket[]> {
    const start = windowStart(checkpoint != null, now);
    return this.health.queryStatisticsCollectionForQuantity(identifier, statistics, start, { day: 1 }, {
      unit,
      filter: { date: { startDate: start, endDate: tomorrow(now) } },
    });
  }

  private async readWorkouts(anchor: string | null, now: Date) {
    const page = await this.health.queryWorkoutSamplesWithAnchor({
      limit: 0,
      ...(anchor ? { anchor } : { filter: { date: { startDate: windowStart(false, now) } } }),
    });
    const workouts = (page.workouts ?? []).map((workout) => (typeof workout.toJSON === "function" ? workout.toJSON() : workout));
    return {
      records: workouts.map((workout) => this.workoutRecord(workout)),
      deleted: (page.deletedSamples ?? []).map((sample) => sample.uuid),
      anchor: page.newAnchor ?? anchor,
    };
  }

  private quantityRecord(type: "weight", sample: HealthSample, fallbackUnit: string): HealthSyncRecord {
    const when = asDate(sample.startDate);
    return {
      record_type: type,
      source_platform: "healthkit",
      external_id: sample.uuid,
      source_app_id: label(sample.sourceRevision?.source?.bundleIdentifier),
      source_device_name: label(sample.device?.name) ?? label(sample.sourceRevision?.source?.name),
      start_time: when.toISOString(),
      end_time: asDate(sample.endDate).toISOString(),
      local_date: localDateISO(when),
      timezone: deviceTimeZone(),
      value: sample.quantity ?? 0,
      unit: sample.unit || fallbackUnit,
    };
  }

  private workoutRecord(workout: WorkoutSample): HealthSyncRecord {
    const when = asDate(workout.startDate);
    const energy = workout.totalEnergyBurned;
    const distance = workout.totalDistance;
    return {
      record_type: "workout",
      source_platform: "healthkit",
      external_id: workout.uuid,
      source_app_id: label(workout.sourceRevision?.source?.bundleIdentifier),
      source_device_name: label(workout.device?.name) ?? label(workout.sourceRevision?.source?.name) ?? "Apple Watch",
      start_time: when.toISOString(),
      end_time: asDate(workout.endDate).toISOString(),
      local_date: localDateISO(when),
      timezone: deviceTimeZone(),
      value: durationSeconds(workout.duration),
      unit: "sec",
      metadata: {
        activity_type: activityLabel(this.health, workout.workoutActivityType),
        workout_kcal: energyKcal(energy),
        ...(distance ? { distance_m: distanceMeters(distance) } : {}),
      },
    };
  }

  private dailyBuckets(
    buckets: readonly StatisticsBucket[],
    type: HealthSyncRecord["record_type"],
    idPrefix: string,
    kind: "sum" | "average" | "recent",
  ): HealthSyncRecord[] {
    const records: HealthSyncRecord[] = [];
    for (const bucket of buckets) {
      const quantity = kind === "sum" ? bucket.sumQuantity : kind === "average" ? bucket.averageQuantity : bucket.mostRecentQuantity ?? bucket.averageQuantity;
      if (!quantity || !includeBucket(bucket, quantity.quantity)) continue;
      const when = asDate(bucket.startDate ?? new Date());
      const source = bucket.sources?.[0];
      records.push({
        record_type: type,
        source_platform: "healthkit",
        external_id: `${idPrefix}${localDateISO(when)}`,
        source_app_id: label(source?.bundleIdentifier),
        source_device_name: label(source?.name),
        start_time: when.toISOString(),
        end_time: asDate(bucket.endDate ?? when).toISOString(),
        local_date: localDateISO(when),
        timezone: deviceTimeZone(),
        value: quantity.quantity,
        unit: quantity.unit || (type === "steps" ? "count" : type === "heart_rate" || type === "resting_heart_rate" ? "count/min" : "kcal"),
        ...(kind === "average"
          ? {
              metadata: {
                min_bpm: bucket.minimumQuantity?.quantity ?? null,
                max_bpm: bucket.maximumQuantity?.quantity ?? null,
              },
            }
          : {}),
      });
    }
    return records;
  }
}

/** Source names go to the server, which rejects empty or very long strings; HealthKit can report "". */
function label(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

function deleted(type: "weight" | "workout", ids: string[]): HealthSyncRecord[] {
  const now = new Date();
  return ids.map((id) => ({
    record_type: type,
    source_platform: "healthkit" as const,
    external_id: id,
    start_time: now.toISOString(),
    end_time: now.toISOString(),
    local_date: localDateISO(now),
    timezone: deviceTimeZone(),
    value: 0,
    unit: type === "weight" ? "kg" : "sec",
    deleted: true,
  }));
}

function includeBucket(bucket: StatisticsBucket, quantity: number): boolean {
  if (bucket.sources && bucket.sources.length === 0) return false;
  if ((!bucket.sources || bucket.sources.length === 0) && quantity === 0) return false;
  return true;
}

function windowStart(incremental: boolean, now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - ((incremental ? 3 : 30) - 1));
  return start;
}

function tomorrow(now: Date): Date {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  end.setDate(end.getDate() + 1);
  return end;
}

function asDate(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return new Date();
}

function durationSeconds(duration: Quantity | undefined): number {
  if (!duration) return 0;
  const unit = (duration.unit ?? "s").toLowerCase();
  if (unit === "min") return Math.round(duration.quantity * 60);
  if (unit === "hr" || unit === "h") return Math.round(duration.quantity * 3600);
  return Math.round(duration.quantity);
}

function energyKcal(energy: Quantity | undefined): number {
  if (!energy) return 0;
  const unit = (energy.unit ?? "kcal").toLowerCase();
  if (unit === "kj") return Math.round((energy.quantity / 4.184) * 10) / 10;
  if (unit === "cal") return Math.round((energy.quantity / 1000) * 10) / 10;
  return Math.round(energy.quantity * 10) / 10;
}

function distanceMeters(distance: Quantity): number {
  const unit = (distance.unit ?? "m").toLowerCase();
  if (unit === "km") return distance.quantity * 1000;
  if (unit === "mi") return distance.quantity * 1609.344;
  return distance.quantity;
}

function activityLabel(api: HealthKitApi, activityType: number | string | undefined): string {
  if (typeof activityType === "string" && Number.isNaN(Number(activityType))) return titleCase(activityType);
  const numeric = typeof activityType === "number" ? activityType : Number(activityType);
  const named = Number.isFinite(numeric) ? api.WorkoutActivityType?.[numeric] : undefined;
  return typeof named === "string" ? titleCase(named) : "Workout";
}

function titleCase(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  if (!spaced) return "Workout";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
