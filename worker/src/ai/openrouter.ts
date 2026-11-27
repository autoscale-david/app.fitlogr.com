import { MealVisionSchema, type MealVision } from "@fitlogr/shared";
import type { Env } from "../env";
import { ApiError } from "../http";

export const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash-lite";
export const DEFAULT_VISION_FALLBACK = "openai/gpt-4o-mini";

const VISION_TIMEOUT_MS = 20_000;

export const VISION_PROMPT = `You classify one photo and estimate calories. Reply with JSON only, no markdown.
Use exactly this shape:
{"classification":"meal"|"workout"|"ignore","is_meal":boolean,"confidence":number,"meal_name":string|null,"suggested_meal_type":"breakfast"|"lunch"|"dinner"|"snack"|"meal"|null,"notes":string|null,"reason":string,"burn_kcal":number|null,"items":[{"name":string,"quantity":number,"unit":string,"estimated_grams":number|null,"calories_kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number,"confidence":number}]}
classification is "meal" only when the photo shows food or drink someone is about to eat. Estimate each visible food item separately. Do not include a meal total. Set burn_kcal to null and is_meal to true.
classification is "workout" when the photo shows an exercise-machine console or another display of energy burned. Set burn_kcal to the digits in the window whose own label reads calories, cal, or kcal. Do not use a number labeled time, distance, speed, pace, watts, mets, heart rate, or resistance, even when that number is larger or easier to see. Do not invent food. Set is_meal to false.
classification is "ignore" when the photo is neither food nor a workout. Set is_meal to false, items to [], and burn_kcal to 0.
reason is one short sentence explaining the classification.`;

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
    "openai/gpt-4o-mini": [0.15, 0.6],
  };
  const [input, output] = rates[model] ?? [0.15, 0.6];
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
      max_tokens: 1200,
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
  try {
    return JSON.parse(stripFence(text));
  } catch {
    return null;
  }
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
