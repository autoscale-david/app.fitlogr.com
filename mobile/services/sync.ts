import type { SQLiteDatabase } from "expo-sqlite";
import type { Goals, MealItemRecord, MealRecord } from "./db";
import { readSetting, writeGoals, writeServerMeal, writeSetting, writeWeightKg } from "./db";
import { deviceTimeZone } from "./dates";
import { ApiError, OfflineError, SessionExpired, api } from "./api";
import { randomUuid } from "./encoding";
import * as Crypto from "expo-crypto";

const BACKOFF_SECONDS = [5, 30, 120, 900, 3600];

export async function queueSettings(db: SQLiteDatabase, goals: Goals): Promise<void> {
  const expected = await readSetting(db, "settings_updated_at");
  await replaceOutbox(db, "settings", "settings", "PUT", "/settings", {
    timezone: deviceTimeZone(),
    unit_system: goals.unitSystem,
    daily_calorie_target_kcal: goals.baseKcal,
    daily_protein_target_g: goals.proteinTarget,
    daily_carbs_target_g: goals.carbsTarget,
    daily_fat_target_g: goals.fatTarget,
    ...(expected ? { expected_updated_at: expected } : {}),
  });
}

export async function queueWeight(db: SQLiteDatabase, localDate: string, weightKg: number): Promise<void> {
  await replaceOutbox(db, "weight", localDate, "POST", "/weight", {
    weight_kg: Math.round(weightKg * 1000) / 1000,
    recorded_at: new Date().toISOString(),
    local_date: localDate,
    timezone: deviceTimeZone(),
  });
}

export async function queueMeal(db: SQLiteDatabase, meal: MealRecord, pendingCreate: boolean): Promise<void> {
  const body = {
    ...(pendingCreate ? { id: meal.id } : {}),
    name: meal.name,
    meal_type: "meal",
    eaten_at: meal.eatenAt,
    local_date: meal.localDate,
    timezone: deviceTimeZone(),
    items: (meal.items && meal.items.length > 0 ? meal.items : [fallbackItem(meal)]).map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      estimated_grams: item.estimatedGrams,
      calories_kcal: item.caloriesKcal,
      protein_g: item.proteinG,
      carbs_g: item.carbsG,
      fat_g: item.fatG,
    })),
  };
  await replaceOutbox(db, "meal", meal.id, pendingCreate ? "POST" : "PATCH", pendingCreate ? "/meals" : `/meals/${meal.id}`, body);
}

export async function queuePhotoExclude(db: SQLiteDatabase, photoId: string): Promise<void> {
  await replaceOutbox(db, "photo", photoId, "POST", `/photos/${photoId}/exclude`, { reason: "not_meal" });
}

export async function queueMealDelete(db: SQLiteDatabase, mealId: string, pendingCreate: boolean): Promise<void> {
  await db.runAsync("DELETE FROM sync_outbox WHERE entity_type = ? AND entity_id = ?", "meal", mealId);
  if (pendingCreate) return;
  await replaceOutbox(db, "meal", mealId, "DELETE", `/meals/${mealId}`, {});
}

export async function syncAccount(db: SQLiteDatabase, force: boolean): Promise<void> {
  await pushPhotoConsent(db);
  await drainOutbox(db, force);
  await pullChanges(db);
}

async function pushPhotoConsent(db: SQLiteDatabase): Promise<void> {
  if ((await readSetting(db, "ai_photo_consent_pending")) !== "1") return;
  const version = await readSetting(db, "ai_photo_consent_version");
  await api.send("PUT", "/settings", { accept_ai_consent: true, ai_consent_version: version });
  await writeSetting(db, "ai_photo_consent_pending", "0");
}

async function drainOutbox(db: SQLiteDatabase, force: boolean): Promise<void> {
  const rows = await db.getAllAsync<{
    id: string;
    method: string;
    path: string;
    payload_json: string;
    retry_count: number;
    next_retry_at: string | null;
  }>("SELECT id, method, path, payload_json, retry_count, next_retry_at FROM sync_outbox ORDER BY created_at");
  const now = new Date().toISOString();
  for (const row of rows) {
    if (!force && row.next_retry_at && row.next_retry_at > now) continue;
    try {
      const payload = row.payload_json === "{}" && row.method === "DELETE" ? undefined : JSON.parse(row.payload_json);
      await sendOutbox(row.method, row.path, payload);
      await db.runAsync("DELETE FROM sync_outbox WHERE id = ?", row.id);
    } catch (error) {
      if (error instanceof OfflineError) throw error;
      if (error instanceof SessionExpired) throw error;
      if (error instanceof ApiError && error.status === 404 && row.method === "DELETE") {
        await db.runAsync("DELETE FROM sync_outbox WHERE id = ?", row.id);
        continue;
      }
      if (error instanceof ApiError && error.status === 409 && row.path === "/settings") {
        const body = JSON.parse(row.payload_json) as Record<string, unknown>;
        delete body.expected_updated_at;
        await sendOutbox(row.method, row.path, body);
        await db.runAsync("DELETE FROM sync_outbox WHERE id = ?", row.id);
        continue;
      }
      const retryCount = row.retry_count + 1;
      const delay = BACKOFF_SECONDS[Math.min(retryCount, BACKOFF_SECONDS.length - 1)] ?? 3600;
      await db.runAsync("UPDATE sync_outbox SET retry_count = ?, next_retry_at = ? WHERE id = ?", retryCount, new Date(Date.now() + delay * 1000).toISOString(), row.id);
      if (error instanceof ApiError && error.status >= 500) throw error;
    }
  }
}

async function sendOutbox(method: string, path: string, payload: unknown): Promise<void> {
  await api.send(method, path, method === "DELETE" ? undefined : payload);
}

async function pullChanges(db: SQLiteDatabase): Promise<void> {
  const blocked = new Set(
    (await db.getAllAsync<{ entity_type: string; entity_id: string }>("SELECT entity_type, entity_id FROM sync_outbox")).map(
      (row) => `${row.entity_type}:${row.entity_id}`,
    ),
  );
  let since = (await readSetting(db, "sync_cursor")) || undefined;
  for (let page = 0; page < 20; page += 1) {
    const changes = await api.sync(since);
    await db.withTransactionAsync(async () => {
      if (changes.settings && !blocked.has("settings:settings")) {
        await writeGoals(db, {
          unitSystem: changes.settings.unit_system,
          baseKcal: changes.settings.daily_calorie_target_kcal ?? 1900,
          proteinTarget: changes.settings.daily_protein_target_g ?? 140,
          carbsTarget: changes.settings.daily_carbs_target_g ?? 210,
          fatTarget: changes.settings.daily_fat_target_g ?? 65,
        });
        await writeSetting(db, "settings_updated_at", changes.settings.updated_at);
      }
      for (const meal of changes.meals) {
        if (blocked.has(`meal:${meal.id}`)) continue;
        if (meal.deleted_at) {
          await db.runAsync("DELETE FROM meal_items WHERE meal_id = ?", meal.id);
          await db.runAsync("DELETE FROM meals WHERE id = ?", meal.id);
          continue;
        }
        await writeServerMeal(db, {
          id: meal.id,
          localDate: meal.local_date,
          name: meal.name,
          eatenAt: meal.eaten_at,
          caloriesKcal: meal.calories_kcal,
          proteinG: meal.protein_g,
          carbsG: meal.carbs_g,
          fatG: meal.fat_g,
          badge: meal.is_user_edited ? "edited" : "ai",
          photoId: meal.photo_id,
          mealType: meal.meal_type,
          timezone: meal.timezone,
          isUserEdited: meal.is_user_edited,
          updatedAt: meal.updated_at,
          items: meal.items.filter((entry) => !entry.deleted_at).map((item) => ({
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            unit: item.unit,
            estimatedGrams: item.estimated_grams,
            caloriesKcal: item.calories_kcal,
            proteinG: item.protein_g,
            carbsG: item.carbs_g,
            fatG: item.fat_g,
            isUserEdited: item.is_user_edited,
          })),
        });
      }
      for (const record of changes.health_records) {
        if (record.record_type !== "weight") continue;
        if (blocked.has(`weight:${record.local_date}`)) continue;
        if (record.deleted_at) {
          await db.runAsync("DELETE FROM weights WHERE local_date = ?", record.local_date);
        } else {
          await writeWeightKg(db, record.local_date, record.value_num);
        }
      }
      await writeSetting(db, "sync_cursor", changes.cursor);
    });
    since = changes.cursor;
    if (!changes.has_more) return;
  }
}

function fallbackItem(meal: MealRecord): MealItemRecord {
  return {
    id: `${meal.id}-item`,
    name: meal.name,
    quantity: 1,
    unit: "serving",
    estimatedGrams: null,
    caloriesKcal: meal.caloriesKcal,
    proteinG: meal.proteinG,
    carbsG: meal.carbsG,
    fatG: meal.fatG,
    isUserEdited: true,
  };
}

async function replaceOutbox(
  db: SQLiteDatabase,
  entityType: string,
  entityId: string,
  method: string,
  path: string,
  payload: unknown,
): Promise<void> {
  await db.runAsync("DELETE FROM sync_outbox WHERE entity_type = ? AND entity_id = ?", entityType, entityId);
  const id = randomUuid(await Crypto.getRandomBytesAsync(16));
  await db.runAsync(
    `INSERT INTO sync_outbox (id, entity_type, entity_id, method, path, payload_json, retry_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    id,
    entityType,
    entityId,
    method,
    path,
    JSON.stringify(payload),
    new Date().toISOString(),
  );
}
