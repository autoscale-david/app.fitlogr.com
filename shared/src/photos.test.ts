import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pngLuma } from "./png";
import {
  AnalyzePhotoMetadataSchema,
  CheckHashesRequestSchema,
  MealCorrectionSchema,
  MealVisionSchema,
  PhotoExcludeRequestSchema,
  PhotoUrlResponseSchema,
  atwaterWarning,
  dHashFromLuma,
  explicitPickReopens,
  hammingDistance,
  isConfirmedMeal,
  localCaptureFromExif,
  matchHash,
  totalsFromVisionItems,
} from "./photos";

describe("explicit photo pick", () => {
  it("reopens a scan that said the photo was not a meal", () => {
    expect(explicitPickReopens("non_meal", true)).toBe(true);
    expect(explicitPickReopens("near_duplicate", true)).toBe(true);
    expect(explicitPickReopens("duplicate", true)).toBe(false);
    expect(explicitPickReopens("non_meal", false)).toBe(false);
  });
});

describe("photo capture day", () => {
  it("uses the EXIF local day, not UTC", () => {
    const when = localCaptureFromExif({ DateTimeOriginal: "2026:11:26 18:30:00" }, new Date("2026-11-27T02:00:00.000Z"));
    expect(when.localDate).toBe("2026-11-26");
    expect(new Date(when.capturedAt).getFullYear()).toBe(2026);
    expect(new Date(when.capturedAt).getDate()).toBe(26);
  });

  it("falls back to now when the photo has no capture time", () => {
    const now = new Date(2026, 10, 26, 13, 5, 0);
    expect(localCaptureFromExif(null, now).localDate).toBe("2026-11-26");
    expect(localCaptureFromExif({ DateTimeOriginal: "not a date" }, now).localDate).toBe("2026-11-26");
  });
});

describe("photo contracts", () => {
  it("accepts a hash batch and rejects an empty one", () => {
    expect(
      CheckHashesRequestSchema.safeParse({
        items: [{ content_sha256: "a".repeat(64), perceptual_hash: "0123456789abcdef" }],
      }).success,
    ).toBe(true);
    expect(CheckHashesRequestSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it("accepts analyze metadata and a fresh photo URL", () => {
    expect(
      AnalyzePhotoMetadataSchema.safeParse({
        content_sha256: "b".repeat(64),
        perceptual_hash: "fedcba9876543210",
        captured_at: "2026-11-23T18:04:00.000Z",
        local_date: "2026-11-23",
        timezone: "America/Los_Angeles",
        source: "manual",
      }).success,
    ).toBe(true);
    expect(
      PhotoUrlResponseSchema.safeParse({
        photo_id: "photo-1",
        status: "missing",
        url: null,
        expires_at: null,
      }).success,
    ).toBe(true);
  });

  it("normalizes vision JSON and ignores model totals", () => {
    const parsed = MealVisionSchema.parse({
      classification: "meal",
      confidence: 0.9,
      mealName: "Soup",
      items: [{ name: "Soup", grams: 300, calories: 120, protein: 6, carbs: 14, fat: 4, confidence: 0.8, total_calories: 9999 }],
    });
    expect(parsed.is_meal).toBe(true);
    expect(parsed.meal_name).toBe("Soup");
    expect(parsed.items[0]?.estimated_grams).toBe(300);
    expect(totalsFromVisionItems(parsed.items)).toEqual({
      calories_kcal: 120,
      protein_g: 6,
      carbs_g: 14,
      fat_g: 4,
    });
    expect("total_calories" in parsed).toBe(false);
  });

  it("reads a workout burn and treats a non-meal as ignore", () => {
    const workout = MealVisionSchema.parse({
      classification: "workout",
      confidence: 0.95,
      meal_name: "Vision Fitness cardio",
      reason: "Console reads 153.",
      burn_kcal: 153,
      items: [],
    });
    expect(workout.is_meal).toBe(false);
    expect(workout.burn_kcal).toBe(153);
    expect(isConfirmedMeal(workout)).toBe(false);

    const ignored = MealVisionSchema.parse({
      classification: "not_meal",
      is_meal: false,
      confidence: 0.9,
      meal_name: null,
      suggested_meal_type: null,
      notes: "A dog",
      items: [],
    });
    expect(ignored.classification).toBe("ignore");
    expect(ignored.burn_kcal).toBeNull();
    expect(ignored.reason).toBeNull();
    expect(isConfirmedMeal(ignored)).toBe(false);

    // Idle exercise console with 0 kcal burn and zero-calorie water both normalize to ignore.
    const idleConsole = MealVisionSchema.parse({
      classification: "workout",
      is_meal: false,
      confidence: 0.9,
      meal_name: null,
      suggested_meal_type: null,
      notes: null,
      reason: "Main menu with no calories shown.",
      burn_kcal: 0,
      items: [],
    });
    expect(idleConsole.classification).toBe("ignore");
    expect(idleConsole.burn_kcal).toBe(0);

    const plainWater = MealVisionSchema.parse({
      classification: "meal",
      is_meal: true,
      confidence: 0.9,
      meal_name: "Glass of water",
      suggested_meal_type: "snack",
      notes: null,
      reason: "Plain water.",
      burn_kcal: null,
      items: [{ name: "Water", quantity: 250, unit: "ml", estimated_grams: 250, calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, confidence: 0.9 }],
    });
    expect(plainWater.classification).toBe("ignore");
    expect(plainWater.items).toEqual([]);

    // Gram-unit quantities over 100 (e.g. 150 g salmon) are accepted instead of failing schema validation.
    const gramMeal = MealVisionSchema.parse({
      classification: "meal",
      is_meal: true,
      confidence: 0.92,
      meal_name: "Grilled salmon",
      suggested_meal_type: "dinner",
      notes: null,
      reason: "Salmon fillet.",
      burn_kcal: null,
      items: [{ name: "Salmon", quantity: 180, unit: "g", estimated_grams: 180, calories_kcal: 360, protein_g: 36, carbs_g: 0, fat_g: 22, confidence: 0.9 }],
    });
    expect(gramMeal.items[0]?.quantity).toBe(180);
  });

  it("rejects a meal below the confidence floor unless the person forced it", () => {
    const low = MealVisionSchema.parse({
      is_meal: true,
      confidence: 0.4,
      meal_name: "Maybe",
      suggested_meal_type: "snack",
      notes: null,
      items: [{ name: "Cracker", quantity: 1, unit: "piece", estimated_grams: 10, calories_kcal: 40, protein_g: 1, carbs_g: 6, fat_g: 1, confidence: 0.4 }],
    });
    expect(isConfirmedMeal(low)).toBe(false);
    expect(isConfirmedMeal(low, true)).toBe(true);
  });

  it("flags a wild Atwater mismatch and accepts exclusion plus correction payloads", () => {
    const item = {
      name: "Oil",
      quantity: 1,
      unit: "tbsp",
      estimated_grams: 14,
      calories_kcal: 20,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 14,
      confidence: 0.5,
    };
    expect(atwaterWarning([item])).toContain("Oil");
    expect(PhotoExcludeRequestSchema.parse(undefined).reason).toBe("not_meal");
    expect(PhotoExcludeRequestSchema.parse({ reason: "user_excluded" }).reason).toBe("user_excluded");
    expect(MealCorrectionSchema.safeParse({ name: "Updated bowl" }).success).toBe(true);
  });

  it("measures dHash distance and classifies exact, near, and excluded photos", () => {
    const dark = new Uint8Array(9 * 8);
    const rising = new Uint8Array(9 * 8);
    for (let index = 0; index < rising.length; index += 1) rising[index] = index % 9;
    const left = dHashFromLuma(dark);
    const right = dHashFromLuma(rising);
    expect(left).toHaveLength(16);
    expect(hammingDistance(left, left)).toBe(0);
    expect(hammingDistance(left, right)).toBeGreaterThan(8);
    expect(hammingDistance("0000000000000000", "00000000000000ff")).toBe(8);

    const at = "2026-11-23T18:00:00.000Z";
    const known = [
      { id: "meal-photo", content_sha256: "a".repeat(64), perceptual_hash: "0000000000000000", status: "analyzed_meal", meal_id: "meal-1", captured_at: at },
      { id: "skip-photo", content_sha256: "b".repeat(64), perceptual_hash: "ffffffffffffffff", status: "excluded", meal_id: null, captured_at: at },
    ];
    expect(matchHash({ content_sha256: "a".repeat(64) }, known).status).toBe("duplicate");
    expect(
      matchHash({ content_sha256: "c".repeat(64), perceptual_hash: "00000000000000ff", captured_at: "2026-11-23T18:05:00.000Z" }, known),
    ).toMatchObject({
      status: "near_duplicate",
      photo_id: "meal-photo",
      meal_id: "meal-1",
    });
    expect(
      matchHash({ content_sha256: "d".repeat(64), perceptual_hash: "fffffffffffffffe", captured_at: "2026-11-23T18:01:00.000Z" }, known).status,
    ).toBe("excluded");
    expect(
      matchHash({ content_sha256: "e".repeat(64), perceptual_hash: "0f0f0f0f0f0f0f0f", captured_at: "2026-11-23T18:01:00.000Z" }, known).status,
    ).toBe("new");
  });

  it("only treats a look-alike photo as a duplicate when it was taken close in time", () => {
    const known = [
      {
        id: "breakfast-monday",
        content_sha256: "a".repeat(64),
        perceptual_hash: "0000000000000000",
        status: "analyzed_meal",
        meal_id: "meal-monday",
        captured_at: "2026-11-23T08:00:00.000Z",
      },
    ];
    // Same bowl, same table, the next morning: a new meal.
    expect(
      matchHash({ content_sha256: "c".repeat(64), perceptual_hash: "0000000000000001", captured_at: "2026-11-24T08:00:00.000Z" }, known).status,
    ).toBe("new");
    // No capture time means no near-duplicate guess.
    expect(matchHash({ content_sha256: "c".repeat(64), perceptual_hash: "0000000000000001" }, known).status).toBe("new");
    // The same moment from another source (e.g. Google Photos) matches even without a usable dHash.
    expect(
      matchHash({ content_sha256: "f".repeat(64), perceptual_hash: null, captured_at: "2026-11-23T08:00:01.000Z" }, known),
    ).toMatchObject({ status: "near_duplicate", photo_id: "breakfast-monday" });
    // Two photos without a dHash that share a timestamp (a batch upload) are not merged.
    const pickerOnly = [{ ...known[0]!, perceptual_hash: null }];
    expect(
      matchHash({ content_sha256: "f".repeat(64), perceptual_hash: null, captured_at: "2026-11-23T08:00:00.000Z" }, pickerOnly).status,
    ).toBe("new");
    // A photo two minutes later with an unrelated dHash is a different plate.
    expect(
      matchHash({ content_sha256: "f".repeat(64), perceptual_hash: "ffffffffffffffff", captured_at: "2026-11-23T08:02:00.000Z" }, known).status,
    ).toBe("new");
  });

  it("reads grayscale from a 9x8 PNG", async () => {
    const png = encodeGrayPng(9, 8, (x) => (x < 4 ? 10 : 200));
    const decoded = await pngLuma(png);
    expect(decoded.width).toBe(9);
    expect(decoded.height).toBe(8);
    expect(dHashFromLuma(decoded.luma)).toBe("1010101010101010");
  });

  it("reads the same grayscale from 16-bit RGBA, which a wide-colour iPhone writes", async () => {
    const png = encodeRgba16Png(9, 8, (x) => (x < 4 ? 10 : 200));
    const decoded = await pngLuma(png);
    expect(decoded.width).toBe(9);
    expect(decoded.height).toBe(8);
    expect([...decoded.luma.subarray(0, 9)]).toEqual([10, 10, 10, 10, 200, 200, 200, 200, 200]);
    expect(dHashFromLuma(decoded.luma)).toBe("1010101010101010");
  });
});

/** 16 bits per channel, RGBA, with the "up" filter on every row after the first to exercise unfiltering. */
function encodeRgba16Png(width: number, height: number, gray: (x: number, y: number) => number): Uint8Array {
  const stride = width * 8;
  const raw = new Uint8Array(height * (1 + stride));
  const plain = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = gray(x, y);
      for (let channel = 0; channel < 4; channel += 1) {
        const at = y * stride + x * 8 + channel * 2;
        plain[at] = channel === 3 ? 255 : value;
        plain[at + 1] = channel === 3 ? 255 : 0x37;
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + stride);
    raw[row] = y === 0 ? 0 : 2;
    for (let x = 0; x < stride; x += 1) {
      const up = y === 0 ? 0 : plain[(y - 1) * stride + x]!;
      raw[row + 1 + x] = (plain[y * stride + x]! - up) & 255;
    }
  }
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 16;
  ihdr[9] = 6;
  return concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

function encodeGrayPng(width: number, height: number, pixel: (x: number, y: number) => number): Uint8Array {
  const raw = new Uint8Array(height * (1 + width));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) raw[row + 1 + x] = pixel(x, y);
  }
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = concat([typeBytes, data]);
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(crcInput));
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
