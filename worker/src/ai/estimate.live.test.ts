import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateFromModelPayload } from "@fitlogr/shared";
import { describe, expect, it } from "vitest";
import { modelJsonFromCompletion, visionCompletionInit, visionConfigFromEnv, type VisionConfig } from "./openrouter";

const fixtures = fileURLToPath(new URL("../../../shared/src/estimate/fixtures/", import.meta.url));
const cases: Array<{ image: string; expectedKind: "meal" | "workout" | "ignore"; expectedExactKcal?: number }> = [
  { image: "01-workout-vision-console.png", expectedKind: "workout", expectedExactKcal: 153 },
  { image: "02-meal-kenzi-latte-pastry.png", expectedKind: "meal" },
  { image: "03-meal-banana-crepes.png", expectedKind: "meal" },
  { image: "04-ignore-fire-pit.png", expectedKind: "ignore", expectedExactKcal: 0 },
];

describe("openrouter vision smoke", () => {
  it("records a live reading when OPENROUTER_API_KEY is already set", async () => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return;

    const config = visionConfigFromEnv({
      OPENROUTER_API_KEY: apiKey,
      OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
      OPENROUTER_VISION_MODEL: process.env.OPENROUTER_VISION_MODEL,
      OPENROUTER_VISION_FALLBACK_MODELS: process.env.OPENROUTER_VISION_FALLBACK_MODELS,
      APP_URL: process.env.APP_URL,
    });
    const failures: string[] = [];
    for (const { image, expectedKind, expectedExactKcal } of cases) {
      try {
        const json = await readModel(config, pngToJpeg(readFileSync(join(fixtures, image))));
        const estimate = estimateFromModelPayload(json);
        if (estimate.kind !== expectedKind) {
          throw new Error(`expected kind=${expectedKind}, got ${estimate.kind}`);
        }
        if (expectedExactKcal !== undefined && Math.round(estimate.kcal) !== expectedExactKcal) {
          throw new Error(`expected kcal=${expectedExactKcal}, got ${estimate.kcal}`);
        }
        writeFileSync(join(fixtures, image.replace(/\.png$/, ".live.json")), `${JSON.stringify(json, null, 2)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "vision smoke failed";
        failures.push(`${image}: ${message}`);
      }
    }
    expect(failures).toEqual([]);
  }, 240_000);
});

async function readModel(config: VisionConfig, image: Uint8Array): Promise<unknown> {
  const models = [config.model];
  if (config.fallbackModel && config.fallbackModel !== config.model) models.push(config.fallbackModel);
  let last = "no response";
  for (const model of models) {
    const init = visionCompletionInit(config, model, image);
    if (String(init.body).includes(config.apiKey)) {
      throw new Error("Refusing to send a vision request whose body contains the API key");
    }
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, init);
    } catch {
      last = `${model} network error`;
      continue;
    }
    if (!response.ok) {
      last = `${model} HTTP ${response.status}`;
      continue;
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      last = `${model} non-JSON HTTP body`;
      continue;
    }
    const json = modelJsonFromCompletion(payload);
    if (!json || typeof json !== "object") {
      last = `${model} empty completion`;
      continue;
    }
    try {
      estimateFromModelPayload(json);
      return json;
    } catch (error) {
      const message = error instanceof Error ? error.message : "schema error";
      last = `${model} schema: ${message} body: ${JSON.stringify(json).slice(0, 1500)}`;
    }
  }
  throw new Error(last);
}

function pngToJpeg(png: Buffer): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "fitlogr-vision-"));
  const pngPath = join(dir, "in.png");
  const jpgPath = join(dir, "out.jpg");
  writeFileSync(pngPath, png);
  execFileSync("ffmpeg", ["-y", "-i", pngPath, "-frames:v", "1", "-q:v", "3", jpgPath], { stdio: "ignore" });
  return readFileSync(jpgPath);
}
