import { z } from "zod";
import type { Env } from "../env";
import { ApiError } from "../http";

export const DEFAULT_TEXT_MODEL = "google/gemini-2.5-flash-lite";
export const DEFAULT_TEXT_FALLBACK = "openai/gpt-4o-mini";

const TEXT_TIMEOUT_MS = 20_000;

const InsightBodySchema = z.object({
  insight: z.string().trim().min(20).max(420),
});

export interface TextConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  appUrl: string;
}

export interface TextAttempt {
  model: string;
  fallbackUsed: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
  status: "ok" | "schema_error" | "upstream_error";
  insight: string | null;
}

export class InsightFailed extends ApiError {
  readonly attempts: TextAttempt[];

  constructor(attempts: TextAttempt[]) {
    super(502, "AI_UPSTREAM_ERROR", "Daily insight failed");
    this.attempts = attempts;
  }
}

export function textConfigFromEnv(env: Env): TextConfig {
  if (!env.OPENROUTER_API_KEY) throw new ApiError(503, "INTERNAL_ERROR", "Daily insights are not configured");
  const fallback =
    env.OPENROUTER_TEXT_FALLBACK_MODELS?.split(",").map((model) => model.trim()).find(Boolean) || DEFAULT_TEXT_FALLBACK;
  return {
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    model: env.OPENROUTER_TEXT_MODEL || DEFAULT_TEXT_MODEL,
    fallbackModel: fallback,
    appUrl: env.APP_URL || "https://fitlogr.com",
  };
}

export async function completeInsight(
  fetchImpl: typeof fetch,
  config: TextConfig,
  prompt: string,
): Promise<{ insight: string; attempts: TextAttempt[] }> {
  const attempts: TextAttempt[] = [];
  const primary = await runModel(fetchImpl, config, prompt, config.model, false);
  attempts.push(primary);
  if (primary.insight) return { insight: primary.insight, attempts };
  if (config.fallbackModel && config.fallbackModel !== config.model) {
    const fallback = await runModel(fetchImpl, config, prompt, config.fallbackModel, true);
    attempts.push(fallback);
    if (fallback.insight) return { insight: fallback.insight, attempts };
  }
  throw new InsightFailed(attempts);
}

async function runModel(
  fetchImpl: typeof fetch,
  config: TextConfig,
  prompt: string,
  model: string,
  fallbackUsed: boolean,
): Promise<TextAttempt> {
  const started = Date.now();
  const attempt = (status: TextAttempt["status"], insight: string | null, usage?: Usage): TextAttempt => ({
    model,
    fallbackUsed,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    estimatedCostUsd: estimateCost(model, usage),
    latencyMs: Math.max(0, Date.now() - started),
    status,
    insight,
  });

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        "http-referer": config.appUrl,
        "x-title": "fitlogr",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 300,
        response_format: { type: "json_object" },
        provider: { data_collection: "deny" },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
    });
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
  const text = messageText(payload);
  if (!text) return attempt("schema_error", null, usage);
  let json: unknown;
  try {
    json = JSON.parse(stripFence(text));
  } catch {
    return attempt("schema_error", null, usage);
  }
  const parsed = InsightBodySchema.safeParse(json);
  if (!parsed.success) return attempt("schema_error", null, usage);
  return attempt("ok", parsed.data.insight, usage);
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
