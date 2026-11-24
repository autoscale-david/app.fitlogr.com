import { z } from "zod";

export const MealTypeSchema = z.enum(["breakfast", "lunch", "dinner", "snack", "meal"]);
export type MealType = z.infer<typeof MealTypeSchema>;

const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);

export const MealItemInputSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().min(1).max(120),
  quantity: z.number().positive().max(1000).optional(),
  unit: z.string().min(1).max(30).optional(),
  estimated_grams: z.number().positive().max(5000).nullable().optional(),
  calories_kcal: z.number().min(0).max(20000),
  protein_g: z.number().min(0).max(2000),
  carbs_g: z.number().min(0).max(2000),
  fat_g: z.number().min(0).max(2000),
});
export type MealItemInput = z.infer<typeof MealItemInputSchema>;

export const MealWriteSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().min(1).max(120),
  meal_type: MealTypeSchema.optional(),
  eaten_at: z.iso.datetime(),
  local_date: z.iso.date(),
  timezone: z.string().min(1).max(80),
  items: z.array(MealItemInputSchema).min(1).max(30),
});
export type MealWrite = z.infer<typeof MealWriteSchema>;

export const MealPatchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    meal_type: MealTypeSchema.optional(),
    eaten_at: z.iso.datetime().optional(),
    local_date: z.iso.date().optional(),
    timezone: z.string().min(1).max(80).optional(),
    items: z.array(MealItemInputSchema).min(1).max(30).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No meal changes" });
export type MealPatch = z.infer<typeof MealPatchSchema>;

export const MealItemSchema = z.object({
  id: z.string(),
  meal_id: z.string(),
  sort_order: z.number().int(),
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  estimated_grams: z.number().nullable(),
  calories_kcal: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  is_user_edited: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});
export type MealItem = z.infer<typeof MealItemSchema>;

export const MealSchema = z.object({
  id: z.string(),
  name: z.string(),
  meal_type: MealTypeSchema,
  eaten_at: z.string(),
  local_date: z.string(),
  timezone: z.string(),
  calories_kcal: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  is_ai_estimate: z.boolean(),
  is_user_edited: z.boolean(),
  user_edited_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  items: z.array(MealItemSchema),
});
export type Meal = z.infer<typeof MealSchema>;

export const MealsQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type MealsQuery = z.infer<typeof MealsQuerySchema>;
