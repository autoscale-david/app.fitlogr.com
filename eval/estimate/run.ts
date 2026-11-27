import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHOTO_LIMITS,
  atwaterWarning,
  estimateFromVision,
  totalsFromVisionItems,
} from "@fitlogr/shared";
import {
  DEFAULT_VISION_FALLBACK,
  DEFAULT_VISION_MODEL,
  VisionFailed,
  analyzeMealVision,
  type VisionConfig,
} from "../../worker/src/ai/openrouter";
import { computeSummary, formatSummaryReport } from "./metrics";
import type { EvalCase, EvalCaseResult, EvalManifest, EvalSplit } from "./types";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = join(REPO_ROOT, "eval/estimate/manifest.json");
const RAW_CACHE_DIR = join(REPO_ROOT, ".cache/estimate-eval/raw");
const PREP_CACHE_DIR = join(REPO_ROOT, ".cache/estimate-eval/prepared");

interface CliOptions {
  splits: Set<EvalSplit>;
  model: string;
  fallback: string;
  maxEdgePx: number;
  jpegQuality: number;
  concurrency: number;
  fetchOnly: boolean;
  idFilter: string | null;
  savePath: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  let splitArg = "dev";
  let model = process.env.OPENROUTER_VISION_MODEL || DEFAULT_VISION_MODEL;
  let fallback = process.env.OPENROUTER_VISION_FALLBACK_MODELS?.split(",")[0]?.trim() || DEFAULT_VISION_FALLBACK;
  let maxEdgePx: number = PHOTO_LIMITS.maxEdgePx;
  let jpegQuality: number = PHOTO_LIMITS.jpegQuality;
  let concurrency = 4;
  let fetchOnly = false;
  let idFilter: string | null = null;
  let savePath: string | null = null;

  for (const arg of argv) {
    if (arg === "--fetch-only") fetchOnly = true;
    else if (arg.startsWith("--split=")) splitArg = arg.slice("--split=".length);
    else if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
    else if (arg.startsWith("--fallback=")) {
      const value = arg.slice("--fallback=".length).trim();
      fallback = value === "none" ? "" : value;
    } else if (arg.startsWith("--max-edge=")) maxEdgePx = Number(arg.slice("--max-edge=".length));
    else if (arg.startsWith("--jpeg-quality=")) jpegQuality = Number(arg.slice("--jpeg-quality=".length));
    else if (arg.startsWith("--concurrency=")) concurrency = Math.max(1, Number(arg.slice("--concurrency=".length)));
    else if (arg.startsWith("--id=")) idFilter = arg.slice("--id=".length);
    else if (arg.startsWith("--save=")) savePath = arg.slice("--save=".length);
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  const splits = new Set<EvalSplit>();
  if (splitArg === "all") {
    splits.add("fixtures");
    splits.add("dev");
    splits.add("test");
  } else {
    for (const part of splitArg.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (part !== "fixtures" && part !== "dev" && part !== "test") {
        throw new Error(`Invalid --split value: ${part}. Use fixtures, dev, test, comma-separated, or all.`);
      }
      splits.add(part);
    }
  }

  return { splits, model, fallback, maxEdgePx, jpegQuality, concurrency, fetchOnly, idFilter, savePath };
}

function printUsage(): void {
  console.log(`Usage: npm run eval:estimate -- [options]
Options:
  --split=fixtures|dev|test|all   Splits to evaluate (comma-separated, default: dev)
  --model=<openrouter-model>      Primary OpenRouter vision model (default: ${DEFAULT_VISION_MODEL})
  --fallback=<model|none>         Fallback model (default: ${DEFAULT_VISION_FALLBACK})
  --max-edge=<px>                 Resize max edge in px (default: ${PHOTO_LIMITS.maxEdgePx})
  --jpeg-quality=<0..1>           JPEG quality 0..1 (default: ${PHOTO_LIMITS.jpegQuality})
  --concurrency=<n>               Parallel OpenRouter requests (default: 4)
  --id=<substring>                Filter cases by ID substring
  --fetch-only                    Download & verify SHA-256 of benchmark images only
  --save=<path>                   Write full JSON results & summary to file`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveRawImage(item: EvalCase): Promise<string> {
  if (item.source.local_path) {
    const abs = join(REPO_ROOT, item.source.local_path);
    if (!existsSync(abs)) throw new Error(`Missing fixture file: ${abs}`);
    const actual = sha256(readFileSync(abs));
    if (actual !== item.source.sha256) {
      throw new Error(`SHA-256 mismatch for ${item.id}: expected ${item.source.sha256}, got ${actual}`);
    }
    return abs;
  }

  if (!item.source.url) throw new Error(`Case ${item.id} has neither local_path nor url`);
  mkdirSync(RAW_CACHE_DIR, { recursive: true });
  const ext = extname(new URL(item.source.url).pathname).toLowerCase() || ".jpg";
  const cachedPath = join(RAW_CACHE_DIR, `${item.id}${ext}`);

  if (existsSync(cachedPath)) {
    const actual = sha256(readFileSync(cachedPath));
    if (actual === item.source.sha256) return cachedPath;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(item.source.url, {
        headers: { "user-agent": "FitLogrEval/1.0 (https://fitlogr.com)" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${item.source.url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = sha256(bytes);
      if (actual !== item.source.sha256) {
        throw new Error(`SHA-256 mismatch for ${item.id}: expected ${item.source.sha256}, got ${actual}`);
      }
      writeFileSync(cachedPath, bytes);
      return cachedPath;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Failed to fetch ${item.id}`);
}

/**
 * Mirrors mobile/services/photos/prepare.ts: scale down so max(w, h) <= maxEdgePx without upscaling,
 * and encode as JPEG. Maps 0..1 quality to ffmpeg mjpeg -q:v scale (2 best .. 31 worst).
 */
function preprocessImage(rawPath: string, caseId: string, maxEdgePx: number, jpegQuality: number): Uint8Array {
  mkdirSync(PREP_CACHE_DIR, { recursive: true });
  const qv = qualityToFfmpegQ(jpegQuality);
  const outPath = join(PREP_CACHE_DIR, `${caseId}_e${maxEdgePx}_q${qv}.jpg`);
  if (!existsSync(outPath)) {
    const scaleFilter = `scale='min(${maxEdgePx},iw)':'min(${maxEdgePx},ih)':force_original_aspect_ratio=decrease`;
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", rawPath, "-vf", scaleFilter, "-frames:v", "1", "-q:v", String(qv), outPath],
      { stdio: "pipe" },
    );
  }
  return new Uint8Array(readFileSync(outPath));
}

function qualityToFfmpegQ(quality: number): number {
  const clamped = Math.max(0.1, Math.min(1, quality));
  // ffmpeg mjpeg qscale: 2 ≈ quality 0.95, 4 ≈ 0.85, 5 ≈ 0.80, 7 ≈ 0.70, 10 ≈ 0.55
  return Math.max(2, Math.min(20, Math.round(2 + (1 - clamped) * 16)));
}

async function runPool<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function next(): Promise<void> {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!, idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
  return results;
}

async function evaluateCase(item: EvalCase, config: VisionConfig, maxEdgePx: number, jpegQuality: number): Promise<EvalCaseResult> {
  const rawPath = await resolveRawImage(item);
  const jpegBytes = preprocessImage(rawPath, item.id, maxEdgePx, jpegQuality);

  try {
    const { analysis, attempts } = await analyzeMealVision(fetch, config, jpegBytes);
    const winning = attempts.find((a) => a.analysis !== null) ?? attempts[attempts.length - 1]!;
    const estimate = estimateFromVision(analysis);
    const totals = analysis.classification === "meal" ? totalsFromVisionItems(analysis.items) : null;
    const totalLatency = attempts.reduce((sum, a) => sum + a.latencyMs, 0);
    const totalCost = attempts.reduce((sum, a) => sum + (a.estimatedCostUsd ?? 0), 0);
    const hasCost = attempts.some((a) => a.estimatedCostUsd !== null);

    return {
      id: item.id,
      split: item.split,
      subcategory: item.subcategory,
      expected: item.expected,
      predicted_kind: estimate.kind,
      predicted_kcal: estimate.kcal,
      predicted_macros: totals ? { protein_g: totals.protein_g, carbs_g: totals.carbs_g, fat_g: totals.fat_g } : null,
      confidence: analysis.confidence,
      reason: estimate.reason,
      atwater_warning: analysis.classification === "meal" ? atwaterWarning(analysis.items) : null,
      schema_valid: true,
      fallback_used: winning.fallbackUsed,
      model_used: winning.model,
      latency_ms: totalLatency,
      prompt_tokens: attempts.reduce((sum, a) => sum + (a.promptTokens ?? 0), 0),
      completion_tokens: attempts.reduce((sum, a) => sum + (a.completionTokens ?? 0), 0),
      estimated_cost_usd: hasCost ? totalCost : null,
      preprocessed_bytes: jpegBytes.byteLength,
      error: null,
      raw_analysis: analysis,
    };
  } catch (err) {
    if (err instanceof VisionFailed) {
      const totalLatency = err.attempts.reduce((sum, a) => sum + a.latencyMs, 0);
      const totalCost = err.attempts.reduce((sum, a) => sum + (a.estimatedCostUsd ?? 0), 0);
      const hasCost = err.attempts.some((a) => a.estimatedCostUsd !== null);
      return {
        id: item.id,
        split: item.split,
        subcategory: item.subcategory,
        expected: item.expected,
        predicted_kind: null,
        predicted_kcal: null,
        predicted_macros: null,
        confidence: null,
        reason: null,
        atwater_warning: null,
        schema_valid: false,
        fallback_used: err.attempts.some((a) => a.fallbackUsed),
        model_used: err.attempts[err.attempts.length - 1]?.model ?? config.model,
        latency_ms: totalLatency,
        prompt_tokens: err.attempts.reduce((sum, a) => sum + (a.promptTokens ?? 0), 0),
        completion_tokens: err.attempts.reduce((sum, a) => sum + (a.completionTokens ?? 0), 0),
        estimated_cost_usd: hasCost ? totalCost : null,
        preprocessed_bytes: jpegBytes.byteLength,
        error: err.attempts.map((a) => `${a.model}:${a.status}`).join(", "),
        raw_analysis: null,
      };
    }
    return {
      id: item.id,
      split: item.split,
      subcategory: item.subcategory,
      expected: item.expected,
      predicted_kind: null,
      predicted_kcal: null,
      predicted_macros: null,
      confidence: null,
      reason: null,
      atwater_warning: null,
      schema_valid: false,
      fallback_used: false,
      model_used: config.model,
      latency_ms: 0,
      prompt_tokens: null,
      completion_tokens: null,
      estimated_cost_usd: null,
      preprocessed_bytes: jpegBytes.byteLength,
      error: err instanceof Error ? err.message : String(err),
      raw_analysis: null,
    };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as EvalManifest;
  const selected = manifest.cases.filter(
    (c) => options.splits.has(c.split) && (!options.idFilter || c.id.includes(options.idFilter)),
  );

  if (selected.length === 0) {
    throw new Error("No benchmark cases matched the requested filters.");
  }

  if (options.fetchOnly) {
    console.log(`Fetching & verifying SHA-256 for ${selected.length} cases...`);
    let verified = 0;
    await runPool(selected, 4, async (item) => {
      await resolveRawImage(item);
      verified += 1;
    });
    console.log(`Verified ${verified}/${selected.length} benchmark images cleanly.`);
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set. Run with --fetch-only for offline dataset verification.");
  }

  const config: VisionConfig = {
    apiKey,
    baseUrl: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    model: options.model,
    fallbackModel: options.fallback,
    appUrl: process.env.APP_URL || "https://fitlogr.com",
  };

  console.log(
    `Running ${selected.length} cases | split=${[...options.splits].join(",")} | model=${config.model}` +
      (config.fallbackModel ? ` (fallback=${config.fallbackModel})` : " (no fallback)") +
      ` | maxEdge=${options.maxEdgePx}px q=${options.jpegQuality} | concurrency=${options.concurrency}`,
  );

  const results = await runPool(selected, options.concurrency, async (item) => {
    return evaluateCase(item, config, options.maxEdgePx, options.jpegQuality);
  });

  const summary = computeSummary(results);
  const label = `${config.model} [${[...options.splits].join(",")}] ${options.maxEdgePx}px q=${options.jpegQuality}`;
  console.log("\n" + formatSummaryReport(label, summary, results));

  if (options.savePath) {
    const absSave = resolve(REPO_ROOT, options.savePath);
    mkdirSync(dirname(absSave), { recursive: true });
    writeFileSync(
      absSave,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          config: {
            model: config.model,
            fallbackModel: config.fallbackModel,
            splits: [...options.splits],
            maxEdgePx: options.maxEdgePx,
            jpegQuality: options.jpegQuality,
          },
          summary,
          results,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`\nSaved full eval artifact to ${absSave}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
