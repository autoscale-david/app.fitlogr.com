import { describe, expect, it } from "vitest";
import { isAllowedAppRedirect, redirectWithParams } from "./redirects";

describe("app redirect allowlist", () => {
  it("allows the native callback and Expo Go return URLs", () => {
    const allowed = [
      "fitlogr://auth/callback",
      "fitlogr://auth/callback/",
      "exp://127.0.0.1:8081/--/auth/callback",
      "exp://192.168.1.20:8081/--/auth/callback",
      "exp://abc.anonymous.exp.direct/--/auth/callback",
      "exp://exp.host/@davidcgweb/fitlogr/--/auth/callback",
      "exp://u.expo.dev/@davidcgweb/fitlogr/--/auth/callback",
      "https://auth.expo.io/@davidcgweb/fitlogr",
      "https://auth.expo.io/@davidcgweb/fitlogr/auth/callback",
      "https://auth.expo.io/@davidcgweb/fitlogr/--/auth/callback",
    ];
    for (const uri of allowed) expect(isAllowedAppRedirect(uri), uri).toBe(true);
  });

  it("rejects open redirects and lookalike hosts", () => {
    const rejected = [
      "https://evil.example/auth/callback",
      "https://fitlogr.com/api/auth/google/callback",
      "fitlogr://evil.example/auth/callback",
      "fitlogr://auth/callback.evil",
      "fitlogr://auth/callback?next=https://evil.example",
      "exp://evil.example/--/auth/callback",
      "exp://192.168.1.20:8081/--/steal",
      "exp://user:pass@192.168.1.20:8081/--/auth/callback",
      "https://auth.expo.io/@davidcgweb/other-app",
      "https://auth.expo.io.evil.example/@davidcgweb/fitlogr",
      "https://evil.example/@davidcgweb/fitlogr",
      "javascript:alert(1)",
      "fitlogr://auth/callback\nhttps://evil.example",
    ];
    for (const uri of rejected) expect(isAllowedAppRedirect(uri), uri).toBe(false);
  });

  it("appends the exchange code without dropping the allowlisted path", () => {
    const location = redirectWithParams("exp://10.0.0.8:8081/--/auth/callback", { exchange_code: "abc" });
    const url = new URL(location);
    expect(url.protocol).toBe("exp:");
    expect(url.pathname).toBe("/--/auth/callback");
    expect(url.searchParams.get("exchange_code")).toBe("abc");
  });
});
