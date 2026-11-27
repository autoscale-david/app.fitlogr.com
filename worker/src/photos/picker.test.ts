import { describe, expect, it } from "vitest";
import { explainPickerFailure } from "./picker";

describe("explainPickerFailure", () => {
  it("names a disabled Photos Picker API", () => {
    const error = explainPickerFailure(403, {
      error: {
        code: 403,
        message: "Photos Picker API has not been used in project 1 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/photospicker.googleapis.com/overview?project=1",
        status: "PERMISSION_DENIED",
        details: [{ reason: "SERVICE_DISABLED" }],
      },
    });
    expect(error.status).toBe(403);
    expect(error.code).toBe("PICKER_API_DISABLED");
    expect(error.message).toContain("photospicker.googleapis.com");
    expect(error.message).not.toBe("Google Photos Picker request failed");
  });

  it("asks for the picker scope when the token cannot call the API", () => {
    const error = explainPickerFailure(403, {
      error: {
        code: 403,
        message: "Request had insufficient authentication scopes.",
        status: "PERMISSION_DENIED",
        details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
      },
    });
    expect(error.code).toBe("SCOPE_REQUIRED");
    expect(error.message).toContain("photospicker.mediaitems.readonly");
  });

  it("keeps Google's status and message for any other failure", () => {
    const error = explainPickerFailure(400, { error: { message: "Invalid JSON payload received.", status: "INVALID_ARGUMENT" } });
    expect(error.status).toBe(502);
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.message).toContain("(400)");
    expect(error.message).toContain("Invalid JSON payload received.");
  });
});
