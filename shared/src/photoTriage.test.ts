import { describe, expect, it } from "vitest";
import { PHOTO_TRIAGE_POLICY, sendsForAnalysis, triage } from "./photoTriage";

describe("photo triage", () => {
  it("sends food at the food threshold and workouts at the workout threshold", () => {
    expect(triage([{ id: "food", confidence: 0.2 }]).verdict).toBe("food");
    expect(triage([{ id: "banana_bread", confidence: 0.2 }]).verdict).toBe("food");
    expect(triage([{ id: "treadmill", confidence: 0.3 }]).verdict).toBe("workout");
    expect(triage([{ id: "exercise_machine", confidence: 0.3 }]).verdict).toBe("workout");
  });

  it("keeps a weak or low-confidence photo for analysis", () => {
    expect(triage([{ id: "food", confidence: 0.05 }, { id: "dog", confidence: 0.9 }]).verdict).toBe("uncertain");
    expect(triage([{ id: "dog", confidence: 0.29 }]).verdict).toBe("uncertain");
    expect(triage([]).verdict).toBe("uncertain");
    expect(sendsForAnalysis("uncertain")).toBe(true);
  });

  it("drops a photo only when something else is clearly more confident", () => {
    const result = triage([{ id: "dog", confidence: 0.91 }, { id: "food", confidence: 0.04 }]);
    expect(result.verdict).toBe("not_relevant");
    expect(sendsForAnalysis(result.verdict)).toBe(false);
  });

  it("can stop sending uncertain photos by changing one flag", () => {
    const strict = { ...PHOTO_TRIAGE_POLICY, sendUncertain: false };
    expect(sendsForAnalysis(triage([], strict).verdict, strict)).toBe(false);
    expect(sendsForAnalysis("food", strict)).toBe(true);
  });
});
