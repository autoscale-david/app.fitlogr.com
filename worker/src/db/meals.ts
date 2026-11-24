import type { Meal, MealItem, MealItemInput, MealPatch, MealWrite } from "@fitlogr/shared";
import { sumMacros } from "@fitlogr/shared";
import { ApiError } from "../http";
import { nowIso, uuidv7 } from "../ids";
import { flag } from "./rows";
import { recomputeDailyIntake } from "./summaries";

interface MealRow {
  id: string;
  name: string;
  meal_type: Meal["meal_type"];
  eaten_at: string;
  local_date: string;
  timezone: string;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  is_ai_estimate: number;
  is_user_edited: number;
  user_edited_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface ItemRow {
  id: string;
  meal_id: string;
  sort_order: number;
  name: string;
  quantity: number;
  unit: string;
  estimated_grams: number | null;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  is_user_edited: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const MEAL_COLUMNS = `id, name, meal_type, eaten_at, local_date, timezone, calories_kcal, protein_g, carbs_g, fat_g,
  is_ai_estimate, is_user_edited, user_edited_at, created_at, updated_at, deleted_at`;

export async function listMeals(db: D1Database, userId: string, from?: string, to?: string): Promise<Meal[]> {
  const result = await db
    .prepare(
      `SELECT ${MEAL_COLUMNS} FROM meals
       WHERE user_id = ? AND deleted_at IS NULL
         AND (? IS NULL OR local_date >= ?)
         AND (? IS NULL OR local_date <= ?)
       ORDER BY local_date, eaten_at
       LIMIT 500`,
    )
    .bind(userId, from ?? null, from ?? null, to ?? null, to ?? null)
    .all<MealRow>();
  return hydrate(db, userId, result.results, false);
}

export async function getMeal(db: D1Database, userId: string, mealId: string): Promise<Meal> {
  const row = await ownedMeal(db, userId, mealId);
  if (!row || row.deleted_at) throw new ApiError(404, "NOT_FOUND", "Meal not found");
  const [meal] = await hydrate(db, userId, [row], false);
  if (!meal) throw new ApiError(404, "NOT_FOUND", "Meal not found");
  return meal;
}

export async function saveMeal(db: D1Database, userId: string, input: MealWrite, now: Date): Promise<Meal> {
  const stamp = nowIso(now);
  const id = input.id ?? uuidv7(now.getTime());
  const existing = await db.prepare("SELECT user_id FROM meals WHERE id = ?").bind(id).first<{ user_id: string }>();
  if (existing && existing.user_id !== userId) throw new ApiError(409, "CONFLICT", "Meal id is not available");
  const totals = sumMacros(input.items);
  const mealType = input.meal_type ?? "meal";
  if (!existing) {
    await db
      .prepare(
        `INSERT INTO meals (
           id, user_id, photo_id, name, meal_type, eaten_at, local_date, timezone,
           calories_kcal, protein_g, carbs_g, fat_g, ai_confidence, ai_notes,
           is_ai_estimate, is_user_edited, user_edited_at, created_at, updated_at, deleted_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 1, ?, ?, ?, NULL)`,
      )
      .bind(
        id,
        userId,
        input.name,
        mealType,
        input.eaten_at,
        input.local_date,
        input.timezone,
        totals.calories_kcal,
        totals.protein_g,
        totals.carbs_g,
        totals.fat_g,
        stamp,
        stamp,
        stamp,
      )
      .run();
  } else {
    await db
      .prepare(
        `UPDATE meals SET
           name = ?, meal_type = ?, eaten_at = ?, local_date = ?, timezone = ?,
           calories_kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ?,
           is_ai_estimate = 0, is_user_edited = 1, user_edited_at = ?, updated_at = ?, deleted_at = NULL
         WHERE id = ? AND user_id = ?`,
      )
      .bind(
        input.name,
        mealType,
        input.eaten_at,
        input.local_date,
        input.timezone,
        totals.calories_kcal,
        totals.protein_g,
        totals.carbs_g,
        totals.fat_g,
        stamp,
        stamp,
        id,
        userId,
      )
      .run();
    await db.prepare("DELETE FROM meal_items WHERE meal_id = ? AND user_id = ?").bind(id, userId).run();
  }
  await insertItems(db, userId, id, input.items, stamp, now);
  await recomputeDailyIntake(db, userId, input.local_date, input.timezone, stamp);
  return getMeal(db, userId, id);
}

export async function patchMeal(db: D1Database, userId: string, mealId: string, patch: MealPatch, now: Date): Promise<Meal> {
  const current = await getMeal(db, userId, mealId);
  const stamp = nowIso(now);
  const nextDate = patch.local_date ?? current.local_date;
  const nextTimezone = patch.timezone ?? current.timezone;
  const items = patch.items ?? current.items.filter((item) => !item.deleted_at).map(itemToInput);
  const totals = sumMacros(items);
  await db
    .prepare(
      `UPDATE meals SET
         name = ?, meal_type = ?, eaten_at = ?, local_date = ?, timezone = ?,
         calories_kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ?,
         is_user_edited = 1, user_edited_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .bind(
      patch.name ?? current.name,
      patch.meal_type ?? current.meal_type,
      patch.eaten_at ?? current.eaten_at,
      nextDate,
      nextTimezone,
      totals.calories_kcal,
      totals.protein_g,
      totals.carbs_g,
      totals.fat_g,
      stamp,
      stamp,
      mealId,
      userId,
    )
    .run();
  if (patch.items) {
    await db.prepare("DELETE FROM meal_items WHERE meal_id = ? AND user_id = ?").bind(mealId, userId).run();
    await insertItems(db, userId, mealId, patch.items, stamp, now);
  } else {
    await db
      .prepare("UPDATE meal_items SET is_user_edited = 1, updated_at = ? WHERE meal_id = ? AND user_id = ? AND deleted_at IS NULL")
      .bind(stamp, mealId, userId)
      .run();
  }
  await recomputeDailyIntake(db, userId, nextDate, nextTimezone, stamp);
  if (nextDate !== current.local_date) await recomputeDailyIntake(db, userId, current.local_date, current.timezone, stamp);
  return getMeal(db, userId, mealId);
}

export async function deleteMeal(db: D1Database, userId: string, mealId: string, now: Date): Promise<void> {
  const current = await getMeal(db, userId, mealId);
  const stamp = nowIso(now);
  const result = await db
    .prepare("UPDATE meals SET deleted_at = ?, updated_at = ?, is_user_edited = 1 WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .bind(stamp, stamp, mealId, userId)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new ApiError(404, "NOT_FOUND", "Meal not found");
  await db
    .prepare("UPDATE meal_items SET deleted_at = ?, updated_at = ? WHERE meal_id = ? AND user_id = ? AND deleted_at IS NULL")
    .bind(stamp, stamp, mealId, userId)
    .run();
  await recomputeDailyIntake(db, userId, current.local_date, current.timezone, stamp);
}

export async function changedMeals(
  db: D1Database,
  userId: string,
  cursor: { t: string; id: string },
  limit: number,
): Promise<Array<{ meal: Meal; updated_at: string; id: string }>> {
  const result = await db
    .prepare(
      `SELECT ${MEAL_COLUMNS} FROM meals
       WHERE user_id = ? AND (updated_at > ? OR (updated_at = ? AND id > ?))
       ORDER BY updated_at, id
       LIMIT ?`,
    )
    .bind(userId, cursor.t, cursor.t, cursor.id, limit)
    .all<MealRow>();
  const meals = await hydrate(db, userId, result.results, true);
  return meals.map((meal) => ({ meal, updated_at: meal.updated_at, id: meal.id }));
}

async function ownedMeal(db: D1Database, userId: string, mealId: string): Promise<MealRow | null> {
  return db.prepare(`SELECT ${MEAL_COLUMNS} FROM meals WHERE id = ? AND user_id = ?`).bind(mealId, userId).first<MealRow>();
}

async function insertItems(db: D1Database, userId: string, mealId: string, items: MealItemInput[], stamp: string, now: Date): Promise<void> {
  let offset = 0;
  for (const item of items) {
    const id = item.id ?? uuidv7(now.getTime() + offset);
    offset += 1;
    await db
      .prepare(
        `INSERT INTO meal_items (
           id, meal_id, user_id, sort_order, name, quantity, unit, estimated_grams,
           calories_kcal, protein_g, carbs_g, fat_g, confidence, is_user_edited, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, NULL)`,
      )
      .bind(
        id,
        mealId,
        userId,
        offset - 1,
        item.name,
        item.quantity ?? 1,
        item.unit ?? "serving",
        item.estimated_grams ?? null,
        item.calories_kcal,
        item.protein_g,
        item.carbs_g,
        item.fat_g,
        stamp,
        stamp,
      )
      .run();
  }
}

async function hydrate(db: D1Database, userId: string, rows: MealRow[], includeDeletedItems: boolean): Promise<Meal[]> {
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => "?").join(", ");
  const deletedClause = includeDeletedItems ? "" : "AND deleted_at IS NULL";
  const items = await db
    .prepare(
      `SELECT id, meal_id, sort_order, name, quantity, unit, estimated_grams, calories_kcal, protein_g, carbs_g, fat_g,
              is_user_edited, created_at, updated_at, deleted_at
       FROM meal_items
       WHERE user_id = ? AND meal_id IN (${placeholders}) ${deletedClause}
       ORDER BY sort_order`,
    )
    .bind(userId, ...rows.map((row) => row.id))
    .all<ItemRow>();
  const byMeal = new Map<string, MealItem[]>();
  for (const item of items.results) {
    const list = byMeal.get(item.meal_id) ?? [];
    list.push(toItem(item));
    byMeal.set(item.meal_id, list);
  }
  return rows.map((row) => toMeal(row, byMeal.get(row.id) ?? []));
}

function toMeal(row: MealRow, items: MealItem[]): Meal {
  return {
    id: row.id,
    name: row.name,
    meal_type: row.meal_type,
    eaten_at: row.eaten_at,
    local_date: row.local_date,
    timezone: row.timezone,
    calories_kcal: row.calories_kcal,
    protein_g: row.protein_g,
    carbs_g: row.carbs_g,
    fat_g: row.fat_g,
    is_ai_estimate: flag(row.is_ai_estimate),
    is_user_edited: flag(row.is_user_edited),
    user_edited_at: row.user_edited_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    items,
  };
}

function toItem(row: ItemRow): MealItem {
  return {
    id: row.id,
    meal_id: row.meal_id,
    sort_order: row.sort_order,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    estimated_grams: row.estimated_grams,
    calories_kcal: row.calories_kcal,
    protein_g: row.protein_g,
    carbs_g: row.carbs_g,
    fat_g: row.fat_g,
    is_user_edited: flag(row.is_user_edited),
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

function itemToInput(item: MealItem): MealItemInput {
  return {
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    estimated_grams: item.estimated_grams,
    calories_kcal: item.calories_kcal,
    protein_g: item.protein_g,
    carbs_g: item.carbs_g,
    fat_g: item.fat_g,
  };
}
