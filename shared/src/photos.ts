import { z } from "zod";
import { MealItemInputSchema, MealPatchSchema, MealSchema, MealTypeSchema } from "./schemas/meals";
import { atwaterCalories, sumMacros, type MacroTotals } from "./nutrition";

/** 64-bit difference-hash length, stored as 16 lowercase hex characters. */
export const DHashSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const PHOTO_LIMITS = {
  maxImageBytes: 2 * 1024 * 1024,
  maxBatch: 100,
  maxEdgePx: 1280,
  jpegQuality: 0.8,
  /** Rolling 24 h cap on vision calls per user. Sized for a one-time history import, not only daily logging. */
  dailyVision: 200,
  burstVision: 30,
  burstWindowMs: 5 * 60 * 1000,
  nearDuplicateDistance: 8,
  /** A perceptual match only counts as the same meal when the two photos were taken this close together. */
  nearDuplicateWindowMs: 15 * 60 * 1000,
  /** Two photos captured this close together are one moment (a burst, or the same photo from another source). */
  sameMomentMs: 2000,
  mealConfidenceMin: 0.55,
  /** Picked Google Photos handled per import request, so one request stays inside Worker limits. */
  pickerPageSize: 5,
  pickerMaxItems: 50,
} as const;

export const AI_PHOTO_CONSENT_VERSION = "2026-11-23";

export const HashCheckStatusSchema = z.enum(["new", "duplicate", "near_duplicate", "excluded", "non_meal"]);
export type HashCheckStatus = z.infer<typeof HashCheckStatusSchema>;

export const CheckHashItemSchema = z.object({
  content_sha256: Sha256Schema,
  perceptual_hash: DHashSchema.nullable().optional(),
  captured_at: z.iso.datetime().optional(),
});
export type CheckHashItem = z.infer<typeof CheckHashItemSchema>;

export const CheckHashesRequestSchema = z.object({
  items: z.array(CheckHashItemSchema).min(1).max(PHOTO_LIMITS.maxBatch),
});
export type CheckHashesRequest = z.infer<typeof CheckHashesRequestSchema>;

export const CheckHashResultSchema = z.object({
  content_sha256: Sha256Schema,
  status: HashCheckStatusSchema,
  photo_id: z.string().nullable(),
  meal_id: z.string().nullable(),
});
export type CheckHashResult = z.infer<typeof CheckHashResultSchema>;

export const CheckHashesResponseSchema = z.object({
  results: z.array(CheckHashResultSchema),
});
export type CheckHashesResponse = z.infer<typeof CheckHashesResponseSchema>;

export const PhotoSourceSchema = z.enum(["device_library", "google_picker", "manual"]);
export type PhotoSource = z.infer<typeof PhotoSourceSchema>;

export const AnalyzePhotoMetadataSchema = z.object({
  client_photo_id: z.string().min(1).max(80).optional(),
  content_sha256: Sha256Schema,
  perceptual_hash: DHashSchema.nullable().optional(),
  captured_at: z.iso.datetime(),
  local_date: z.iso.date(),
  timezone: z.string().min(1).max(80),
  device_id: z.string().min(1).max(80).optional(),
  source: PhotoSourceSchema.optional(),
  force_meal: z.boolean().optional(),
});
export type AnalyzePhotoMetadata = z.infer<typeof AnalyzePhotoMetadataSchema>;

const VisionItemObjectSchema = z.object({
  name: z.string().min(1).max(100),
  quantity: z.number().positive().max(1000),
  unit: z.string().min(1).max(30),
  estimated_grams: z.number().positive().max(5000).nullable(),
  calories_kcal: z.number().min(0).max(5000),
  protein_g: z.number().min(0).max(500),
  carbs_g: z.number().min(0).max(1000),
  fat_g: z.number().min(0).max(500),
  confidence: z.number().min(0).max(1),
});

export const MealVisionItemSchema = z.preprocess((item) => normalizeVisionItem(item), VisionItemObjectSchema);
export type MealVisionItem = z.infer<typeof VisionItemObjectSchema>;

const VisionObjectSchema = z
  .object({
    classification: z.enum(["meal", "workout", "ignore"]),
    is_meal: z.boolean(),
    confidence: z.number().min(0).max(1),
    meal_name: z.string().min(1).max(120).nullable(),
    suggested_meal_type: MealTypeSchema.nullable(),
    notes: z.string().max(300).nullable(),
    reason: z.string().max(300).nullable(),
    burn_kcal: z.number().min(0).max(20000).nullable(),
    items: z.array(MealVisionItemSchema).max(30),
  })
  .refine((value) => value.is_meal === (value.classification === "meal"), {
    message: "classification does not match is_meal",
  });

/**
 * OpenRouter vision payload.
 * Meal totals are summed from items. `burn_kcal` is the machine readout for a workout.
 * Older `not_meal` payloads normalize to `ignore`.
 */
export const MealVisionSchema = z.preprocess(normalizeVision, VisionObjectSchema);
export type MealVision = z.infer<typeof VisionObjectSchema>;

export const PhotoStatusSchema = z.enum([
  "analyzed_meal",
  "analyzed_non_meal",
  "excluded",
  "duplicate",
  "upload_failed",
  "quota_exceeded",
]);
export type PhotoStatus = z.infer<typeof PhotoStatusSchema>;

export const GooglePhotoStatusSchema = z.enum(["none", "uploaded", "missing", "quota_exceeded", "failed"]);
export type GooglePhotoStatus = z.infer<typeof GooglePhotoStatusSchema>;

export const PhotoReferenceSchema = z.object({
  id: z.string(),
  status: PhotoStatusSchema,
  is_meal: z.boolean(),
  google_media_item_id: z.string().nullable(),
  google_status: GooglePhotoStatusSchema,
  content_sha256: Sha256Schema,
  duplicate_of_photo_id: z.string().nullable(),
});
export type PhotoReference = z.infer<typeof PhotoReferenceSchema>;

export const AnalyzePhotoResponseSchema = z.object({
  outcome: z.enum(["meal", "not_meal", "duplicate"]),
  photo: PhotoReferenceSchema,
  meal: MealSchema.nullable(),
  /** The meal was saved but Google refused the album upload; the app should ask the person to reconnect. */
  google_reconnect_required: z.boolean().optional(),
});
export type AnalyzePhotoResponse = z.infer<typeof AnalyzePhotoResponseSchema>;

export const PhotoUrlStatusSchema = z.enum(["ok", "missing", "quota_exceeded", "unavailable"]);
export type PhotoUrlStatus = z.infer<typeof PhotoUrlStatusSchema>;

export const PhotoUrlResponseSchema = z.object({
  photo_id: z.string(),
  status: PhotoUrlStatusSchema,
  url: z.string().nullable(),
  expires_at: z.string().nullable(),
});
export type PhotoUrlResponse = z.infer<typeof PhotoUrlResponseSchema>;

export const PhotoExcludeRequestSchema = z
  .object({
    reason: z.enum(["not_meal", "user_excluded"]).optional(),
  })
  .default({ reason: "not_meal" });
export type PhotoExcludeRequest = z.infer<typeof PhotoExcludeRequestSchema>;

export const PickerSessionSchema = z.object({
  session_id: z.string().min(1),
  picker_uri: z.string().url(),
  polling_config: z.object({
    poll_interval_ms: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
  }),
});
export type PickerSession = z.infer<typeof PickerSessionSchema>;

export const PickerStatusSchema = z.object({
  session_id: z.string().min(1),
  media_items_set: z.boolean(),
});
export type PickerStatus = z.infer<typeof PickerStatusSchema>;

export const PickerImportRequestSchema = z.object({
  /** Opaque position from the previous page's `next_cursor`. Omit for the first page. */
  cursor: z.string().min(1).max(4000).optional(),
  /**
   * Set by apps that follow `next_cursor`. Without it (older app builds) the server imports up to 10
   * photos in one call and closes the session, as it always did.
   */
  paged: z.boolean().optional(),
});
export type PickerImportRequest = z.infer<typeof PickerImportRequestSchema>;

export const PickerImportSummarySchema = z.object({
  total_picked: z.number().int(),
  meals_imported: z.number().int(),
  non_meals_skipped: z.number().int(),
  duplicates_skipped: z.number().int(),
  errors: z.number().int(),
  /** Send this back to import the next picked photos. Null once every picked photo was handled. */
  next_cursor: z.string().nullable().optional(),
  /** Set when photo analysis hit its rate limit; wait this long, then resume with `next_cursor`. */
  retry_after_seconds: z.number().int().positive().nullable().optional(),
});
export type PickerImportSummary = z.infer<typeof PickerImportSummarySchema>;

/**
 * EXIF DateTimeOriginal is local wall time (`YYYY:MM:DD HH:MM:SS`), not UTC.
 * Missing or unreadable tags fall back to `now` so a photo taken today still lands on today.
 */
export function localCaptureFromExif(
  exif: Record<string, unknown> | null | undefined,
  now = new Date(),
): { capturedAt: string; localDate: string } {
  const raw = exifString(exif, "DateTimeOriginal") ?? exifString(exif, "DateTimeDigitized") ?? exifString(exif, "DateTime");
  const parsed = raw ? parseExifLocal(raw) : null;
  if (parsed) return parsed;
  return { capturedAt: now.toISOString(), localDate: formatLocalDate(now) };
}

function exifString(exif: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = exif?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseExifLocal(raw: string): { capturedAt: string; localDate: string } | null {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { capturedAt: date.toISOString(), localDate: `${match[1]}-${match[2]}-${match[3]}` };
}

function formatLocalDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export const PhotoExcludeResponseSchema = z.object({
  photo_id: z.string(),
  status: z.literal("excluded"),
  meal_id: z.string().nullable(),
});
export type PhotoExcludeResponse = z.infer<typeof PhotoExcludeResponseSchema>;

/** Item-level correction. PATCH /api/meals/:id applies this and sets is_user_edited. */
export const MealCorrectionSchema = MealPatchSchema;
export type MealCorrection = z.infer<typeof MealCorrectionSchema>;

export const MealItemCorrectionSchema = MealItemInputSchema;
export type MealItemCorrection = z.infer<typeof MealItemCorrectionSchema>;

export interface KnownPhotoHash {
  id: string;
  content_sha256: string;
  perceptual_hash: string | null;
  status: string;
  meal_id: string | null;
  captured_at?: string | null;
}

export function hammingDistance(left: string, right: string): number {
  if (left.length !== right.length || left.length === 0) return 64;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number.parseInt(left[index] ?? "", 16);
    const b = Number.parseInt(right[index] ?? "", 16);
    if (Number.isNaN(a) || Number.isNaN(b)) return 64;
    let xor = a ^ b;
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/** Horizontal dHash. `luma` is row-major grayscale for a 9×8 image (64 comparisons). */
export function dHashFromLuma(luma: Uint8Array, width = 9, height = 8): string {
  if (width !== 9 || height !== 8 || luma.length < width * height) {
    throw new Error("dHash expects a 9x8 grayscale image");
  }
  let hex = "";
  for (let y = 0; y < height; y += 1) {
    let nibble = 0;
    for (let x = 0; x < width - 1; x += 1) {
      const bit = (luma[y * width + x] ?? 0) < (luma[y * width + x + 1] ?? 0) ? 1 : 0;
      nibble = (nibble << 1) | bit;
      if (x % 4 === 3) {
        hex += nibble.toString(16);
        nibble = 0;
      }
    }
  }
  return hex;
}

export function totalsFromVisionItems(items: readonly MealVisionItem[]): MacroTotals {
  return sumMacros(items);
}

export function isConfirmedMeal(analysis: MealVision, forceMeal = false): boolean {
  const calledMeal = analysis.classification === "meal" && analysis.is_meal;
  if (!calledMeal && !forceMeal) return false;
  if (analysis.confidence < PHOTO_LIMITS.mealConfidenceMin && !forceMeal) return false;
  return analysis.items.length > 0 || forceMeal;
}

export function atwaterWarning(items: readonly MealVisionItem[]): string | null {
  const names = items
    .filter((item) => {
      const expected = atwaterCalories(item.protein_g, item.carbs_g, item.fat_g);
      if (expected < 20) return false;
      return Math.abs(item.calories_kcal - expected) / expected > 0.5;
    })
    .map((item) => item.name);
  if (names.length === 0) return null;
  return `Calorie check differs from 4/4/9 for: ${names.join(", ")}`.slice(0, 300);
}

/**
 * Exact SHA-256 matches are always duplicates. A perceptual (dHash) match, or a photo with no
 * usable hash, only counts as the same meal when both photos were taken close together: the same
 * bowl photographed on two different mornings is two meals.
 */
/**
 * A photo chosen in the Log picker is a meal the person wants logged. An earlier automatic scan
 * that called it not a meal, or a near match, must not drop that pick. An exact copy of a meal
 * already logged stays a duplicate so the existing meal is shown instead of analyzed again.
 */
export function explicitPickReopens(matchStatus: string | undefined, forceMeal: boolean): boolean {
  if (!forceMeal) return false;
  return matchStatus === "non_meal" || matchStatus === "near_duplicate";
}

export function matchHash(item: CheckHashItem, known: readonly KnownPhotoHash[]): CheckHashResult {
  const exact = known.find((photo) => photo.content_sha256 === item.content_sha256);
  if (exact) return toHashResult(item.content_sha256, exact, "exact");
  const capturedAt = timestamp(item.captured_at);
  if (capturedAt === null) return newResult(item.content_sha256);
  const hash = item.perceptual_hash;
  let nearest: KnownPhotoHash | null = null;
  let nearestScore = Number.POSITIVE_INFINITY;
  for (const photo of known) {
    const knownAt = timestamp(photo.captured_at);
    if (knownAt === null) continue;
    const gap = Math.abs(knownAt - capturedAt);
    if (gap > PHOTO_LIMITS.nearDuplicateWindowMs) continue;
    let score: number | null = null;
    // Same instant, one side without a dHash: a Google Photos copy of a phone photo. Two photos that both
    // lack a dHash are not matched by time alone, since a batch upload can give many photos one timestamp.
    if (gap <= PHOTO_LIMITS.sameMomentMs && !hash !== !photo.perceptual_hash) score = 0;
    else if (hash && photo.perceptual_hash) {
      const distance = hammingDistance(hash, photo.perceptual_hash);
      if (distance <= PHOTO_LIMITS.nearDuplicateDistance) score = distance + 1;
    }
    if (score !== null && score < nearestScore) {
      nearest = photo;
      nearestScore = score;
    }
  }
  if (nearest) return toHashResult(item.content_sha256, nearest, "near");
  return newResult(item.content_sha256);
}

function newResult(contentSha256: string): CheckHashResult {
  return { content_sha256: contentSha256, status: "new", photo_id: null, meal_id: null };
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toHashResult(contentSha256: string, photo: KnownPhotoHash, kind: "exact" | "near"): CheckHashResult {
  let status: HashCheckStatus;
  if (photo.status === "excluded") status = "excluded";
  else if (photo.status === "analyzed_non_meal") status = "non_meal";
  else status = kind === "near" ? "near_duplicate" : "duplicate";
  return {
    content_sha256: contentSha256,
    status,
    photo_id: photo.id,
    meal_id: photo.meal_id,
  };
}

function normalizeVision(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const record = { ...(input as Record<string, unknown>) };
  if (record.classification === "not_meal" || record.classification === "non_meal" || record.classification === "none") {
    record.classification = "ignore";
  }
  if (record.classification === undefined && typeof record.is_meal === "boolean") {
    record.classification = record.is_meal ? "meal" : "ignore";
  }
  if (record.is_meal === undefined && typeof record.classification === "string") {
    record.is_meal = record.classification === "meal";
  }
  const topConfidence = finiteNumber(record.confidence);
  if (topConfidence !== null) record.confidence = Math.max(0, Math.min(1, topConfidence));

  if (record.meal_name === undefined && typeof record.mealName === "string") record.meal_name = record.mealName;
  if (typeof record.meal_name === "string") {
    const trimmed = record.meal_name.trim().slice(0, 120);
    record.meal_name = trimmed === "" ? null : trimmed;
  } else if (record.meal_name === undefined) {
    record.meal_name = null;
  }

  if (record.suggested_meal_type === undefined || record.suggested_meal_type === "") record.suggested_meal_type = null;
  if (typeof record.notes === "string") {
    const trimmed = record.notes.trim().slice(0, 300);
    record.notes = trimmed === "" ? null : trimmed;
  } else if (record.notes === undefined) {
    record.notes = null;
  }

  if (typeof record.reason !== "string" || record.reason.trim() === "") record.reason = null;
  else record.reason = record.reason.trim().slice(0, 300);

  const parsedBurn = finiteNumber(record.burn_kcal);
  if (parsedBurn !== null) record.burn_kcal = Math.max(0, parsedBurn);
  else if (record.burn_kcal === undefined || record.burn_kcal === null || record.burn_kcal === "") record.burn_kcal = null;

  const fallbackConfidence = typeof record.confidence === "number" ? record.confidence : 0.7;
  if (Array.isArray(record.items)) {
    record.items = record.items.map((item) => normalizeVisionItem(item, fallbackConfidence));
  } else if (record.items === undefined || record.items === null) {
    record.items = [];
  }

  // An exercise console showing no active energy burned (e.g. idle menu or lifetime distance) is not a workout burn.
  if (record.classification === "workout") {
    const burn = typeof record.burn_kcal === "number" ? record.burn_kcal : 0;
    const itemKcal = sumNormalizedItemKcal(record.items);
    if (burn <= 0 && itemKcal <= 0) {
      record.classification = "ignore";
      record.is_meal = false;
      record.burn_kcal = 0;
      record.items = [];
    }
  }

  // Zero-calorie items only (e.g. plain water or ice) are not a loggable meal.
  if (record.classification === "meal" && Array.isArray(record.items) && record.items.length > 0) {
    if (sumNormalizedItemKcal(record.items) <= 0) {
      record.classification = "ignore";
      record.is_meal = false;
      record.burn_kcal = 0;
      record.items = [];
    }
  }
  return record;
}

function sumNormalizedItemKcal(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    const kcal = item && typeof item === "object" ? finiteNumber((item as Record<string, unknown>).calories_kcal) : null;
    return sum + (kcal ?? 0);
  }, 0);
}

function normalizeVisionItem(input: unknown, fallbackConfidence = 0.7): unknown {
  if (!input || typeof input !== "object") return input;
  const record = { ...(input as Record<string, unknown>) };

  if (typeof record.name === "string") record.name = record.name.trim().slice(0, 100);
  if (typeof record.unit === "string") {
    const trimmed = record.unit.trim().slice(0, 30);
    record.unit = trimmed || "serving";
  } else if (record.unit === undefined || record.unit === null) {
    record.unit = "serving";
  }

  if (record.estimated_grams === undefined && record.grams !== undefined) record.estimated_grams = record.grams;
  const grams = finiteNumber(record.estimated_grams);
  if (grams !== null) record.estimated_grams = grams > 0 ? Math.min(5000, grams) : null;
  else if (record.estimated_grams === undefined || record.estimated_grams === "") record.estimated_grams = null;

  const qty = finiteNumber(record.quantity);
  if (qty === null || qty <= 0) {
    record.quantity = 1;
  } else if (qty > 1000) {
    if (record.estimated_grams === null && /^(g|gram|grams|ml)$/i.test(String(record.unit))) {
      record.estimated_grams = Math.min(5000, qty);
    }
    record.quantity = 1;
    record.unit = "serving";
  } else {
    record.quantity = qty;
  }

  if (record.calories_kcal === undefined && record.calories !== undefined) record.calories_kcal = record.calories;
  if (record.protein_g === undefined && record.protein !== undefined) record.protein_g = record.protein;
  if (record.carbs_g === undefined && record.carbs !== undefined) record.carbs_g = record.carbs;
  if (record.fat_g === undefined && record.fat !== undefined) record.fat_g = record.fat;

  for (const field of ["calories_kcal", "protein_g", "carbs_g", "fat_g"] as const) {
    const num = finiteNumber(record[field]);
    if (num !== null) record[field] = Math.max(0, num);
  }

  const conf = finiteNumber(record.confidence);
  record.confidence = conf !== null ? Math.max(0, Math.min(1, conf)) : fallbackConfidence;

  return record;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
