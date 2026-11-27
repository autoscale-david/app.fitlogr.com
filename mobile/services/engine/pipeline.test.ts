import { describe, expect, it } from "vitest";
import { isFinalAudit, runPipeline, type AnalyzeOutcome, type PipelinePhoto, type PipelineRow } from "./pipeline";

const DAY = 24 * 60 * 60 * 1000;

function photo(id: string, daysAgo: number, screenshot = false): PipelinePhoto {
  return { id, capturedAtMs: Date.UTC(2026, 10, 26) - daysAgo * DAY, screenshot };
}

function meal(id: string): PipelineRow {
  return {
    id,
    capturedAtMs: photo(id, 1).capturedAtMs,
    captureDate: "2026-11-25",
    source: "library",
    verdict: "food",
    labels: [{ id: "food", confidence: 0.9 }],
    classifierId: "stub",
    policyVersion: "1",
    classifiedAt: "2026-11-25T00:00:00.000Z",
    aiState: "meal",
    classification: "meal",
    confidence: 0.9,
    estimate: { name: "Already logged" },
    remotePhotoId: "remote-1",
    mealId: "meal-1",
    error: null,
  };
}

describe("photo pipeline", () => {
  it("analyses newest captures first and leaves a final row untouched", async () => {
    const older = photo("older", 3);
    const newer = photo("newer", 0);
    const done = meal("done");
    const snapshot = structuredClone(done);
    const rows = new Map<string, PipelineRow>([[done.id, done]]);
    const classified: string[] = [];
    const analysed: string[] = [];
    const result = await runPipeline({
      discovered: [older, donePhoto(done), newer],
      rows,
      nowMs: Date.UTC(2026, 10, 26, 18),
      budgetMs: Infinity,
      resumeAtMs: null,
      source: "library",
      classifierId: "stub-pass-all",
      policyVersion: "pass-all",
      classify: async (item) => {
        classified.push(item.id);
        return { labels: [{ id: "food", confidence: 1 }] };
      },
      decide: () => ({ verdict: "food", send: true }),
      analyze: async (item) => {
        analysed.push(item.id);
        return { kind: "meal", name: item.id, kcal: 100, mealId: `m-${item.id}`, remotePhotoId: `p-${item.id}` };
      },
      toLocalDate: () => "2026-11-26",
      clock: () => 0,
    });
    expect(classified).toEqual(["newer", "older"]);
    expect(analysed).toEqual(["newer", "older"]);
    expect(rows.get("done")).toEqual(snapshot);
    expect(result.logged.map((item) => item.name)).toEqual(["newer", "older"]);
    expect(result.counts.meals).toBe(2);
  });

  it("stops on a rate limit, remembers when to resume, and continues afterwards", async () => {
    const photos = [photo("a", 0), photo("b", 1), photo("c", 2)];
    const rows = new Map<string, PipelineRow>();
    const analysed: string[] = [];
    const first = await runPipeline({
      ...base(photos, rows),
      analyze: async (item) => {
        analysed.push(item.id);
        if (item.id === "a") return { kind: "rate_limited", retryAfterSeconds: 120 };
        return { kind: "meal", name: item.id, kcal: 10 };
      },
    });
    expect(analysed).toEqual(["a"]);
    expect(first.resumeAtMs).toBe(base(photos, rows).nowMs + 120_000);
    expect(rows.get("a")?.aiState).toBe("queued");
    expect(rows.get("b")?.aiState).toBe("queued");

    analysed.length = 0;
    const held = await runPipeline({
      ...base(photos, rows),
      nowMs: first.resumeAtMs! - 1,
      resumeAtMs: first.resumeAtMs,
      analyze: async () => {
        analysed.push("nope");
        return { kind: "meal", name: "nope", kcal: 1 };
      },
    });
    expect(analysed).toEqual([]);
    expect(held.counts.waiting).toBe(3);

    const resumed = await runPipeline({
      ...base(photos, rows),
      nowMs: first.resumeAtMs!,
      resumeAtMs: first.resumeAtMs,
      analyze: async (item) => {
        analysed.push(item.id);
        return { kind: "meal", name: item.id, kcal: 10, mealId: item.id };
      },
    });
    expect(analysed).toEqual(["a", "b", "c"]);
    expect(resumed.counts.waiting).toBe(0);
    expect(resumed.resumeAtMs).toBeNull();
  });

  it("keeps going when one photo cannot be read or analysed", async () => {
    const photos = [photo("bad-read", 0), photo("bad-send", 1), photo("ok", 2)];
    const rows = new Map<string, PipelineRow>();
    const result = await runPipeline({
      ...base(photos, rows),
      classify: async (item) => {
        if (item.id === "bad-read") throw new Error("unreadable");
        return { labels: [{ id: "food", confidence: 1 }] };
      },
      analyze: async (item) => {
        if (item.id === "bad-send") throw new Error("upstream");
        return { kind: "meal", name: "Ok", kcal: 80, mealId: "ok" };
      },
    });
    expect(rows.get("bad-read")?.aiState).toBe("error");
    expect(rows.get("bad-read")?.verdict).toBe("unreadable");
    expect(rows.get("bad-send")?.aiState).toBe("error");
    expect(rows.get("ok")?.aiState).toBe("meal");
    expect(result.counts.meals).toBe(1);
    expect(result.counts.errors).toBe(2);
    expect(isFinalAudit(rows.get("ok")!)).toBe(true);
    expect(isFinalAudit(rows.get("bad-send")!)).toBe(false);
  });

  it("a simulated background pass respects the time budget and leaves the rest queued", async () => {
    const photos = [photo("one", 0), photo("two", 1), photo("three", 2)];
    const rows = new Map<string, PipelineRow>();
    let ticks = 0;
    const analysed: string[] = [];
    const result = await runPipeline({
      ...base(photos, rows),
      budgetMs: 3,
      clock: () => {
        ticks += 1;
        return ticks;
      },
      analyze: async (item) => {
        analysed.push(item.id);
        return { kind: "meal", name: item.id, kcal: 1 };
      },
    });
    expect(result.stoppedForBudget).toBe(true);
    expect(analysed.length).toBeLessThan(3);
    expect(result.counts.waiting).toBeGreaterThan(0);
  });

  it("logs a fresh photo before it even classifies the backlog", async () => {
    const photos = [photo("today", 0), ...Array.from({ length: 5 }, (_, index) => photo(`old-${index}`, 10 + index))];
    const rows = new Map<string, PipelineRow>();
    const order: string[] = [];
    await runPipeline({
      ...base(photos, rows),
      nowMs: photo("today", 0).capturedAtMs + 60_000,
      classify: async (item) => {
        order.push(`classify:${item.id}`);
        return { labels: [{ id: "food", confidence: 1 }] };
      },
      analyze: async (item) => {
        order.push(`analyse:${item.id}`);
        return { kind: "meal", name: item.id, kcal: 1 };
      },
    });
    expect(order.slice(0, 3)).toEqual(["classify:today", "analyse:today", "classify:old-0"]);
  });
});

describe("photo pipeline bookkeeping", () => {
  it("persists classification before analysis and the result after it", async () => {
    const photos = [photo("a", 0), photo("shot", 1, true)];
    const rows = new Map<string, PipelineRow>();
    const saved: string[] = [];
    await runPipeline({
      ...base(photos, rows),
      persist: async (row) => {
        saved.push(`${row.id}:${row.aiState}`);
      },
      analyze: async () => ({ kind: "meal", name: "A", kcal: 5, mealId: "m-a" }),
    });
    // "a" is from today, so it is sent before yesterday's screenshot is even looked at.
    expect(saved).toEqual(["a:queued", "a:meal", "shot:not_sent"]);
    expect(rows.get("a")?.analysedAt).toEqual(expect.any(String));
  });

  it("stops retrying a photo that keeps failing, and never re-classifies it for an analysis error", async () => {
    const photos = [photo("bad", 0)];
    const rows = new Map<string, PipelineRow>();
    let classified = 0;
    let sent = 0;
    const once = () =>
      runPipeline({
        ...base(photos, rows),
        classify: async () => {
          classified += 1;
          return { labels: [{ id: "food", confidence: 1 }] };
        },
        analyze: async () => {
          sent += 1;
          return { kind: "error", message: "Meal analysis failed" };
        },
      });
    await once();
    expect(rows.get("bad")).toMatchObject({ aiState: "error", attempts: 1 });
    await once();
    await once();
    expect(rows.get("bad")).toMatchObject({ aiState: "failed", attempts: 3 });
    await once();
    expect(sent).toBe(3);
    expect(classified).toBe(1);
    expect(isFinalAudit(rows.get("bad")!)).toBe(true);
  });

  it("leaves a photo queued when another pass is already sending it", async () => {
    const photos = [photo("busy", 0), photo("free", 1)];
    const rows = new Map<string, PipelineRow>();
    const result = await runPipeline({
      ...base(photos, rows),
      analyze: async (item) => (item.id === "busy" ? { kind: "skip" } : { kind: "meal", name: "Free", kcal: 1 }),
    });
    expect(rows.get("busy")?.aiState).toBe("queued");
    expect(rows.get("free")?.aiState).toBe("meal");
    expect(result.counts.waiting).toBe(1);
  });

  it("measures a rate-limit wait from when the limit was hit, not from when the pass began", async () => {
    const photos = [photo("a", 0)];
    const rows = new Map<string, PipelineRow>();
    let now = 0;
    const result = await runPipeline({
      ...base(photos, rows),
      clock: () => now,
      analyze: async () => {
        now += 90_000; // the pass had been running a while before the server said no
        return { kind: "rate_limited", retryAfterSeconds: 60 };
      },
    });
    expect(result.resumeAtMs).toBe(base(photos, rows).nowMs + 90_000 + 60_000);
  });
});

function donePhoto(row: PipelineRow): PipelinePhoto {
  return { id: row.id, capturedAtMs: row.capturedAtMs, screenshot: false };
}

function base(discovered: PipelinePhoto[], rows: Map<string, PipelineRow>) {
  return {
    discovered,
    rows,
    nowMs: Date.UTC(2026, 10, 26, 18),
    budgetMs: Infinity,
    resumeAtMs: null as number | null,
    source: "library" as const,
    classifierId: "stub-pass-all",
    policyVersion: "pass-all",
    classify: async () => ({ labels: [{ id: "food", confidence: 1 }] }),
    decide: () => ({ verdict: "food" as const, send: true }),
    analyze: async (): Promise<AnalyzeOutcome> => ({ kind: "meal", name: "Meal", kcal: 1 }),
    toLocalDate: () => "2026-11-26",
    clock: () => 0,
  };
}
