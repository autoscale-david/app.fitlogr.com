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

  it("an outage does not write off the queue: two failures stop the pass, and nothing becomes final", async () => {
    const photos = [photo("a", 0), photo("b", 1), photo("c", 2), photo("d", 3), photo("e", 4)];
    const rows = new Map<string, PipelineRow>();
    let sent = 0;
    const outage = () =>
      runPipeline({
        ...base(photos, rows),
        analyze: async () => {
          sent += 1;
          return { kind: "error", message: "Meal analysis failed" };
        },
      });
    await outage();
    await outage();
    await outage();
    // Each pass gave up after two failures in a row, and the wait kept the same photos from being re-sent.
    expect(sent).toBeLessThanOrEqual(6);
    expect([...rows.values()].some((row) => row.aiState === "failed")).toBe(false);
    expect([...rows.values()].every((row) => !isFinalAudit(row))).toBe(true);

    const recovered = await runPipeline({
      ...base(photos, rows),
      nowMs: base(photos, rows).nowMs + 3 * 24 * 60 * 60 * 1000,
      analyze: async (item) => ({ kind: "meal", name: item.id, kcal: 1 }),
    });
    expect(recovered.counts.waiting).toBe(0);
    expect([...rows.values()].every((row) => row.aiState === "meal")).toBe(true);
  });

  it("waits before re-sending a photo that failed, and never re-classifies it", async () => {
    const photos = [photo("bad", 0), photo("good", 1)];
    const rows = new Map<string, PipelineRow>();
    let classified = 0;
    const sent: string[] = [];
    const pass = (nowMs: number) =>
      runPipeline({
        ...base(photos, rows),
        nowMs,
        classify: async () => {
          classified += 1;
          return { labels: [{ id: "food", confidence: 1 }] };
        },
        analyze: async (item) => {
          sent.push(item.id);
          return item.id === "bad" ? { kind: "error", message: "Meal analysis failed" } : { kind: "meal", name: "Good", kcal: 1 };
        },
      });
    const start = base(photos, rows).nowMs;
    await pass(start);
    expect(rows.get("bad")).toMatchObject({ aiState: "error", attempts: 1 });
    await pass(start + 60_000);
    expect(sent).toEqual(["bad", "good"]);
    await pass(start + 6 * 60_000);
    expect(sent).toEqual(["bad", "good", "bad"]);
    expect(rows.get("bad")).toMatchObject({ aiState: "error", attempts: 2 });
    expect(classified).toBe(2);
  });

  it("gives up at once when the server rejects the photo itself", async () => {
    const photos = [photo("huge", 0)];
    const rows = new Map<string, PipelineRow>();
    await runPipeline({
      ...base(photos, rows),
      analyze: async () => ({ kind: "error", message: "Photo must be 2 MB or smaller", permanent: true }),
    });
    expect(rows.get("huge")?.aiState).toBe("failed");
    expect(isFinalAudit(rows.get("huge")!)).toBe(true);
  });

  it("lets an expired session end the pass instead of marking photos", async () => {
    class Expired extends Error {}
    const photos = [photo("a", 0), photo("b", 1)];
    const rows = new Map<string, PipelineRow>();
    await expect(
      runPipeline({
        ...base(photos, rows),
        isFatal: (error) => error instanceof Expired,
        analyze: async () => {
          throw new Expired();
        },
      }),
    ).rejects.toBeInstanceOf(Expired);
    expect(rows.get("a")?.aiState).toBe("queued");
  });

  it("ends early when asked to stop, leaving the rest for the next pass", async () => {
    const photos = [photo("a", 0), photo("b", 1), photo("c", 2)];
    const rows = new Map<string, PipelineRow>();
    let stop = false;
    const result = await runPipeline({
      ...base(photos, rows),
      shouldStop: () => stop,
      analyze: async (item) => {
        stop = true; // the app went to the background while this one was being sent
        return { kind: "meal", name: item.id, kcal: 1 };
      },
    });
    expect(result.stoppedForBudget).toBe(true);
    expect(result.counts.meals).toBe(1);
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

  it("forgets a rate limit that has passed, even when photos are still waiting", async () => {
    const photos = [photo("a", 0), photo("b", 1), photo("c", 2)];
    const rows = new Map<string, PipelineRow>();
    const limited = await runPipeline({
      ...base(photos, rows),
      analyze: async () => ({ kind: "rate_limited", retryAfterSeconds: 60 }),
    });
    expect(limited.resumeAtMs).not.toBeNull();
    // Ten minutes later the limit is over, but the phone is offline.
    const offline = await runPipeline({
      ...base(photos, rows),
      nowMs: base(photos, rows).nowMs + 10 * 60_000,
      resumeAtMs: limited.resumeAtMs,
      analyze: async () => ({ kind: "paused" }),
    });
    expect(offline.counts.waiting).toBe(3);
    expect(offline.resumeAtMs).toBeNull();
  });

  it("applies a new policy to photos kept on the phone, from their stored labels", async () => {
    const photos = [photo("pasta", 2), photo("receipt", 3), photo("shot", 4, true)];
    const rows = new Map<string, PipelineRow>();
    // Policy 1 keeps everything on the phone.
    await runPipeline({ ...base(photos, rows), policyVersion: "1", decide: () => ({ verdict: "not_relevant", send: false }) });
    expect([...rows.values()].every((row) => row.aiState === "not_sent")).toBe(true);

    // Policy 2 sends anything labelled food. The photos are not read again.
    let classified = 0;
    rows.set("pasta", { ...rows.get("pasta")!, labels: [{ id: "pasta", confidence: 0.4 }] });
    rows.set("receipt", { ...rows.get("receipt")!, labels: [{ id: "document", confidence: 0.9 }] });
    const next = await runPipeline({
      ...base(photos, rows),
      policyVersion: "2",
      classify: async () => {
        classified += 1;
        return { labels: [] };
      },
      decide: (labels) => (labels.some((label) => label.id === "pasta") ? { verdict: "food", send: true } : { verdict: "not_relevant", send: false }),
    });
    expect(classified).toBe(0);
    expect(rows.get("pasta")).toMatchObject({ aiState: "meal", verdict: "food", policyVersion: "2" });
    expect(rows.get("receipt")).toMatchObject({ aiState: "not_sent", policyVersion: "2" });
    expect(rows.get("shot")).toMatchObject({ aiState: "not_sent", verdict: "screenshot" });
    expect(next.counts.meals).toBe(1);
  });

  it("a photo that cannot be loaded is not a failed analysis: no wait, and it does not end the pass", async () => {
    const photos = [photo("gone-1", 0), photo("gone-2", 1), photo("gone-3", 2), photo("fine", 3)];
    const rows = new Map<string, PipelineRow>();
    const first = await runPipeline({
      ...base(photos, rows),
      analyze: async (item) =>
        item.id === "fine" ? { kind: "meal", name: "Fine", kcal: 1 } : { kind: "error", local: true, message: "Still in iCloud" },
    });
    // Three in a row did not trip the outage breaker, and nothing counted as analysed but the meal.
    expect(rows.get("fine")?.aiState).toBe("meal");
    expect(first.counts.analysed).toBe(1);
    expect(rows.get("gone-1")).toMatchObject({ aiState: "error", attempts: 0, analysedAt: null });

    // The very next pass tries them again, without classifying again.
    let classified = 0;
    const second = await runPipeline({
      ...base(photos, rows),
      nowMs: base(photos, rows).nowMs + 1000,
      classify: async () => {
        classified += 1;
        return { labels: [{ id: "food", confidence: 1 }] };
      },
      analyze: async (item) => ({ kind: "meal", name: item.id, kcal: 1 }),
    });
    expect(classified).toBe(0);
    expect(second.counts.waiting).toBe(0);
    expect([...rows.values()].every((row) => row.aiState === "meal")).toBe(true);
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
