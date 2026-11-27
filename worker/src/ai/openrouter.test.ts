import { describe, expect, it } from "vitest";
import { analyzeMealVision, visionConfigFromEnv, type VisionConfig } from "./openrouter";

const config: VisionConfig = {
  apiKey: "test-openrouter-key",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "google/gemini-2.5-flash-lite",
  fallbackModel: "openai/gpt-4o-mini",
  appUrl: "https://fitlogr.com",
};

const meal = {
  classification: "meal",
  is_meal: true,
  confidence: 0.93,
  meal_name: "Chicken rice bowl",
  suggested_meal_type: "lunch",
  notes: null,
  total_calories: 9999,
  items: [
    {
      name: "Chicken",
      quantity: 1,
      unit: "breast",
      estimated_grams: 150,
      calories_kcal: 100.4,
      protein_g: 20.2,
      carbs_g: 0,
      fat_g: 3.3,
      confidence: 0.8,
    },
    {
      name: "Rice",
      quantity: 1,
      unit: "cup",
      estimated_grams: 180,
      calories_kcal: 50.25,
      protein_g: 10.1,
      carbs_g: 5.1,
      fat_g: 1.2,
      confidence: 0.7,
    },
  ],
};

describe("openrouter vision", () => {
  it("validates structured JSON, drops model totals, and records token usage", async () => {
    const seen: Array<{ model: string; deny: boolean; keyInBody: boolean }> = [];
    const result = await analyzeMealVision(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      seen.push({
        model: body.model,
        deny: body.provider?.data_collection === "deny",
        keyInBody: String(init?.body).includes("test-openrouter-key"),
      });
      return Response.json({
        choices: [{ message: { content: JSON.stringify(meal) } }],
        usage: { prompt_tokens: 400, completion_tokens: 80, cost: 0.00021 },
      });
    }, config, jpeg());

    expect(seen).toEqual([{ model: "google/gemini-2.5-flash-lite", deny: true, keyInBody: false }]);
    expect(result.analysis.items).toHaveLength(2);
    expect(result.analysis).not.toHaveProperty("total_calories");
    expect(result.attempts[0]).toMatchObject({
      status: "ok",
      fallbackUsed: false,
      promptTokens: 400,
      completionTokens: 80,
      estimatedCostUsd: 0.00021,
    });
  });

  it("falls back when the primary model returns invalid JSON", async () => {
    const models: string[] = [];
    const result = await analyzeMealVision(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      models.push(body.model);
      if (body.model === config.model) {
        return Response.json({ choices: [{ message: { content: "not json" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
      }
      return Response.json({
        choices: [{ message: { content: JSON.stringify(meal) } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      });
    }, config, jpeg());

    expect(models).toEqual(["google/gemini-2.5-flash-lite", "openai/gpt-4o-mini"]);
    expect(result.analysis.meal_name).toBe("Chicken rice bowl");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["schema_error", "ok"]);
    expect(result.attempts[1]?.fallbackUsed).toBe(true);
    expect(result.attempts[1]?.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("fails when every model errors", async () => {
    await expect(
      analyzeMealVision(async () => new Response("no", { status: 503 }), config, jpeg()),
    ).rejects.toMatchObject({ code: "AI_UPSTREAM_ERROR", attempts: [expect.objectContaining({ status: "upstream_error" }), expect.objectContaining({ status: "upstream_error", fallbackUsed: true })] });
  });

  it("asks the model to separate meals, workouts, and everything else", async () => {
    let prompt = "";
    await analyzeMealVision(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      prompt = body.messages[0].content[0].text;
      return Response.json({
        choices: [{ message: { content: JSON.stringify(meal) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      });
    }, config, jpeg());
    expect(prompt).toContain('"meal"');
    expect(prompt).toContain('"workout"');
    expect(prompt).toContain('"ignore"');
    expect(prompt).toContain("calories, cal, or kcal");
  });

  it("accepts a console workout and an ignore photo", async () => {
    const payloads = [
      {
        classification: "workout",
        is_meal: false,
        confidence: 0.9,
        meal_name: "Bike",
        suggested_meal_type: null,
        notes: null,
        reason: "Console reads 153.",
        burn_kcal: 153,
        items: [],
      },
      {
        classification: "ignore",
        is_meal: false,
        confidence: 0.9,
        meal_name: null,
        suggested_meal_type: null,
        notes: null,
        reason: "Not food.",
        burn_kcal: 0,
        items: [],
      },
      {
        classification: "not_meal",
        is_meal: false,
        confidence: 0.9,
        meal_name: null,
        suggested_meal_type: null,
        notes: "A dog",
        items: [],
      },
    ];
    const seen: string[] = [];
    for (const payload of payloads) {
      const result = await analyzeMealVision(async () => {
        return Response.json({ choices: [{ message: { content: JSON.stringify(payload) } }] });
      }, config, jpeg());
      seen.push(result.analysis.classification);
    }
    expect(seen).toEqual(["workout", "ignore", "ignore"]);
  });

  it("reads the configured model and falls back to gpt-4o-mini", () => {
    expect(
      visionConfigFromEnv({
        OPENROUTER_API_KEY: "key",
        OPENROUTER_VISION_MODEL: "google/gemini-2.5-flash-lite",
      }),
    ).toMatchObject({ model: "google/gemini-2.5-flash-lite", fallbackModel: "openai/gpt-4o-mini" });
  });
});

function jpeg(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
}
