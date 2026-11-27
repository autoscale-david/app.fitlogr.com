import { MealVisionSchema, type MealVision } from "@fitlogr/shared";
import type { Env } from "../env";
import { ApiError } from "../http";

export const DEFAULT_VISION_MODEL = "google/gemini-3.5-flash-lite";
export const DEFAULT_VISION_FALLBACK = "openai/gpt-4.1-mini";

const VISION_TIMEOUT_MS = 20_000;

export const VISION_PROMPT = `You classify one photo for a nutrition and fitness log and estimate calories. Reply with JSON only, no markdown fences or extra text.
Use this exact JSON key order so you verify visual evidence before choosing numbers:
{"scene_check":string,"console_windows":[{"label":string,"value":string,"unit":string}],"portion_notes":string|null,"classification":"meal"|"workout"|"ignore","is_meal":boolean,"confidence":number,"meal_name":string|null,"suggested_meal_type":"breakfast"|"lunch"|"dinner"|"snack"|"meal"|null,"notes":string|null,"reason":string,"burn_kcal":number|null,"items":[{"name":string,"quantity":number,"unit":string,"estimated_grams":number|null,"protein_g":number,"carbs_g":number,"fat_g":number,"calories_kcal":number,"confidence":number}]}

1. Classification rules:
- "meal": ONLY when the photo shows actual edible food or a caloric beverage (>=10 kcal, e.g. latte, juice, smoothie, soda, alcohol) that someone is about to eat or is eating. Set is_meal to true, burn_kcal to null, console_windows to [].
- "workout": ONLY when the photo shows an exercise-machine console or workout summary screen displaying an active or completed calorie burn (> 0) with a window labeled calories, cal, or kcal. Set is_meal to false, items to [], portion_notes to null.
- "ignore": Everything else, including:
  * plain water, ice, or plain black coffee / unsweetened tea with no milk, cream, sugar, or food;
  * empty or finished plates with only crumbs, sauce smudges, or utensils;
  * menus, signs, receipts, or unopened retail boxes/grocery shelves;
  * vehicle dashboards, speedometers, kitchen/bathroom scales, ovens, or clocks;
  * gym weights/equipment with no readable calorie readout, OR idle/powered-off/menu-only/lifetime-distance exercise consoles that do NOT display workout calories burned (> 0).
  Set is_meal to false, items to [], burn_kcal to 0, console_windows to [], portion_notes to null.

2. Workout console OCR rules (when "workout"):
- Transcribe every visible numeric display window into console_windows with its exact label (check lit LED indicators/arrows next to multi-label windows), exact digits, and unit. Preserve any visible decimal point exactly (e.g. 2.45 is not 245, and 185.0 is 185 not 1850), and do not invent a decimal point where none is lit.
- Set burn_kcal strictly from the cumulative total window labeled calories, cal, or kcal (or "Calories Burned"). NEVER pick a rate window ("Cal/hr", "Cal/min"), split/interval calories, time, distance, speed, pace, watts, RPM/SPM, incline, resistance, METs, or heart rate, even if larger or brighter.
- Cross-check physical plausibility against elapsed time and effort (typical cardio burns ~4-18 kcal/min); if a candidate violates that wildly, re-check whether you misread a decimal point, distance, rate, or watts instead of total calories.

3. Meal estimation rules (when "meal"):
- In portion_notes, anchor physical scale from the container/plate/cup/utensils (full dinner/cafeteria plate ~25-27 cm / 10 in; standard cafe cup ~12 fl oz / 355 ml), count exact visible halves/pieces/cuts, and inspect surfaces for glossy cooking oil, salad dressing/vinaigrette, mayonnaise, creamy sauces, butter, pesto, spreads, syrups, cheese, nuts, or whipped cream.
- Estimate each visible food item separately in items; do not include a meal-total row.
- Estimate realistic cooked/plated gram weight (estimated_grams) from actual plate area and mound depth rather than tiny textbook minimums: a palm-sized cooked meat/fish portion is ~120-150g and a generous entree portion is ~180-250g; 1 cup cooked grains/pasta is ~160-180g; a full cafe pastry, thick waffle, or whole bagel is ~110-150g while half a bagel or small thin cut is ~45-55g; a generous mound of nuts is ~45-55g.
- Account for visible or clearly prepared fats, dressings, sauces, syrups, spreads, and milk in coffee drinks (1 tsp oil ~4.5g / 40 kcal; 1 tbsp oil or vinaigrette ~14g / 115-120 kcal; 1-2 tbsp creamy sauce/mayo ~15-30g / 100-200 kcal; 1-2 tbsp syrup ~20-40g / 52-105 kcal). Do not add oil to plain raw produce or dry steamed foods, and do not double-count oil/dressing both inside a dish item and as a separate oil item.
- Ground protein_g, carbs_g, fat_g, and calories_kcal in USDA FoodData Central densities for estimated_grams, and verify each item satisfies calories_kcal ≈ 4*protein_g + 4*carbs_g + 9*fat_g.

4. reason is one short sentence explaining the classification.`;

export interface VisionConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  appUrl: string;
}

export interface VisionAttempt {
  model: string;
  fallbackUsed: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
  status: "ok" | "schema_error" | "upstream_error";
  analysis: MealVision | null;
}

export class VisionFailed extends ApiError {
  readonly attempts: VisionAttempt[];

  constructor(attempts: VisionAttempt[]) {
    super(502, "AI_UPSTREAM_ERROR", "Meal analysis failed");
    this.attempts = attempts;
  }
}

export function visionConfigFromEnv(env: Env): VisionConfig {
  if (!env.OPENROUTER_API_KEY) throw new ApiError(503, "INTERNAL_ERROR", "Meal analysis is not configured");
  const fallback =
    env.OPENROUTER_VISION_FALLBACK_MODELS?.split(",").map((model) => model.trim()).find(Boolean) || DEFAULT_VISION_FALLBACK;
  return {
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    model: env.OPENROUTER_VISION_MODEL || DEFAULT_VISION_MODEL,
    fallbackModel: fallback,
    appUrl: env.APP_URL || "https://fitlogr.com",
  };
}

export async function analyzeMealVision(
  fetchImpl: typeof fetch,
  config: VisionConfig,
  image: Uint8Array,
): Promise<{ analysis: MealVision; attempts: VisionAttempt[] }> {
  const attempts: VisionAttempt[] = [];
  const primary = await runModel(fetchImpl, config, image, config.model, false);
  attempts.push(primary);
  if (primary.analysis) return { analysis: primary.analysis, attempts };
  if (config.fallbackModel && config.fallbackModel !== config.model) {
    const fallback = await runModel(fetchImpl, config, image, config.fallbackModel, true);
    attempts.push(fallback);
    if (fallback.analysis) return { analysis: fallback.analysis, attempts };
  }
  throw new VisionFailed(attempts);
}

async function runModel(
  fetchImpl: typeof fetch,
  config: VisionConfig,
  image: Uint8Array,
  model: string,
  fallbackUsed: boolean,
): Promise<VisionAttempt> {
  const started = Date.now();
  const attempt = (status: VisionAttempt["status"], analysis: MealVision | null, usage?: Usage): VisionAttempt => ({
    model,
    fallbackUsed,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    estimatedCostUsd: estimateCost(model, usage),
    latencyMs: Math.max(0, Date.now() - started),
    status,
    analysis,
  });

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/chat/completions`, visionCompletionInit(config, model, image));
  } catch {
    return attempt("upstream_error", null);
  }
  if (!response.ok) return attempt("upstream_error", null);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return attempt("schema_error", null);
  }
  const usage = readUsage(payload);
  const json = modelJsonFromCompletion(payload);
  if (!json) return attempt("schema_error", null, usage);
  const parsed = MealVisionSchema.safeParse(json);
  if (!parsed.success) return attempt("schema_error", null, usage);
  return attempt("ok", parsed.data, usage);
}

interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
  reportedCost: number | null;
}

function readUsage(payload: unknown): Usage {
  const usage = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown } }).usage;
  return {
    promptTokens: numberOrNull(usage?.prompt_tokens),
    completionTokens: numberOrNull(usage?.completion_tokens),
    reportedCost: numberOrNull(usage?.cost),
  };
}

function estimateCost(model: string, usage: Usage | undefined): number | null {
  if (!usage) return null;
  if (usage.reportedCost !== null) return roundCost(usage.reportedCost);
  if (usage.promptTokens === null && usage.completionTokens === null) return null;
  const rates: Record<string, [number, number]> = {
    "google/gemini-2.5-flash-lite": [0.1, 0.4],
    "google/gemini-2.5-flash": [0.3, 2.5],
    "google/gemini-3.1-flash-lite": [0.25, 1.5],
    "google/gemini-3.5-flash-lite": [0.3, 2.5],
    "google/gemini-3-flash-preview": [0.5, 3.0],
    "openai/gpt-4o-mini": [0.15, 0.6],
    "openai/gpt-4.1-mini": [0.4, 1.6],
    "openai/gpt-5.4-nano": [0.2, 1.25],
    "openai/gpt-5.4-mini": [0.75, 4.5],
    "anthropic/claude-haiku-5.5": [0.1, 0.5],
  };
  const [input, output] = rates[model] ?? [0.4, 1.6];
  return roundCost(((usage.promptTokens ?? 0) * input + (usage.completionTokens ?? 0) * output) / 1_000_000);
}

function roundCost(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function visionCompletionInit(config: VisionConfig, model: string, image: Uint8Array): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      "http-referer": config.appUrl,
      "x-title": "fitlogr",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 2048,
      response_format: { type: "json_object" },
      provider: { data_collection: "deny" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${bytesToBase64(image)}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  };
}

/** Model JSON from a chat completion, or null when the message is missing or not JSON. */
export function modelJsonFromCompletion(payload: unknown): unknown | null {
  const text = messageText(payload);
  if (!text) return null;
  const cleaned = stripFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const extracted = extractFirstJsonObject(cleaned);
    if (!extracted) return null;
    try {
      return JSON.parse(extracted);
    } catch {
      return null;
    }
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function messageText(payload: unknown): string | null {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
  return text || null;
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced?.[1]?.trim() ?? trimmed;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + size));
  }
  return btoa(binary);
}
