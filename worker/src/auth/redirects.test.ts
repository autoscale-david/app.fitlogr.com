import { describe, expect, it } from "vitest";
import { isAllowedAppRedirect, redirectWithParams } from "./redirects";

const UPDATE = "01a20c91-e031-7a2a-816c-f0d510b91266";
const PROJECT = "1964593c-a6a0-49e5-a35b-240cf2bf254e";

describe("app redirect allowlist", () => {
  it("allows native, dev-client, and Expo Go return URLs", () => {
    const allowed = [
      "fitlogr://auth/callback",
      "fitlogr://auth/callback/",
      "exp+fitlogr://auth/callback",
      "exp+fitlogr://expo-development-client/--/auth/callback",
      "exp+fitlogr://expo-development-client/--/auth/callback?url=http%3A%2F%2F127.0.0.1%3A8081",
      `exp://u.expo.dev/update/${UPDATE}/--/auth/callback`,
      `exps://u.expo.dev/update/${UPDATE}/--/auth/callback`,
      `exp://u.expo.dev/update/${UPDATE}/--/auth/callback?runtime-version=0.1.0&channel-name=preview`,
      `exps://u.expo.dev/${PROJECT}/--/auth/callback?channel-name=preview`,
      `exp://u.expo.dev/${PROJECT}/auth/callback`,
      "exp://u.expo.dev/@davidcgweb/fitlogr/--/auth/callback",
      "exp://exp.host/@davidcgweb/fitlogr/--/auth/callback",
      "exps://exp.host/@davidcgweb/fitlogr/--/auth/callback",
      "exp://exp.host/@davidcgweb/fitlogr/--/auth/callback?release-channel=default",
      "exp://127.0.0.1:8081/--/auth/callback",
      "exp://localhost:8081/--/auth/callback",
      "exp://10.0.0.8:8081/--/auth/callback",
      "exp://172.16.0.5:8081/--/auth/callback",
      "exp://172.31.255.4:19000/--/auth/callback",
      "exp://192.168.1.20:8081/--/auth/callback",
      "exps://192.168.0.12:8081/--/auth/callback",
      "exp://abc.anonymous.exp.direct/--/auth/callback",
      "https://auth.expo.io/@davidcgweb/fitlogr",
      "https://auth.expo.io/@davidcgweb/fitlogr/auth/callback",
      "https://auth.expo.io/@davidcgweb/fitlogr/--/auth/callback",
    ];
    for (const uri of allowed) expect(isAllowedAppRedirect(uri), uri).toBe(true);
  });

  it("rejects open redirects and lookalike hosts", () => {
    const rejected = [
      "https://evil.com/auth/callback",
      "https://evil.example/auth/callback",
      "https://fitlogr.com/api/auth/google/callback",
      "https://u.expo.dev/update/abc/--/auth/callback",
      "fitlogr://evil.example/auth/callback",
      "fitlogr://auth/callback.evil",
      "fitlogr://auth/callback?next=https://evil.example",
      "exp://evil.com/--/auth/callback",
      "exp://evil.com/update/abc/--/auth/callback",
      "exps://evil.com/update/abc/--/auth/callback",
      "exp://u.expo.dev.evil.com/update/abc/--/auth/callback",
      "exp://u.expo.dev/other-app/--/auth/callback",
      "exp://u.expo.dev/update/--/auth/callback",
      `exp://exp.host/@attacker/fitlogr/--/auth/callback`,
      "exp://exp.host/@davidcgweb/other/--/auth/callback",
      "exp://user:pass@u.expo.dev/update/abc/--/auth/callback",
      "exp://u.expo.dev@evil.com/update/abc/--/auth/callback",
      "exp://evil.com@u.expo.dev/update/abc/--/auth/callback",
      "exp://8.8.8.8:8081/--/auth/callback",
      "exp://172.32.0.5:8081/--/auth/callback",
      "exp://192.168.1.20:8081/--/steal",
      "exp://192.168.1.20.evil.com/--/auth/callback",
      "javascript:alert(1)",
      "fitlogr://auth/callback\nhttps://evil.example",
      "https://auth.expo.io/@davidcgweb/other-app",
      "https://auth.expo.io.evil.example/@davidcgweb/fitlogr",
      "https://evil.example/@davidcgweb/fitlogr",
      "exp+other://auth/callback",
    ];
    for (const uri of rejected) expect(isAllowedAppRedirect(uri), uri).toBe(false);
  });

  it("appends the exchange code with ? or & and keeps the Expo Go path", () => {
    const bare = redirectWithParams("exp://10.0.0.8:8081/--/auth/callback", { exchange_code: "abc" });
    const bareUrl = new URL(bare);
    expect(bareUrl.protocol).toBe("exp:");
    expect(bareUrl.pathname).toBe("/--/auth/callback");
    expect(bareUrl.searchParams.get("exchange_code")).toBe("abc");
    expect(bare).toContain("?exchange_code=abc");

    const update = `exps://u.expo.dev/update/${UPDATE}/--/auth/callback?runtime-version=0.1.0`;
    const withCode = redirectWithParams(update, { exchange_code: "code-1" });
    const updateUrl = new URL(withCode);
    expect(updateUrl.protocol).toBe("exps:");
    expect(updateUrl.hostname).toBe("u.expo.dev");
    expect(updateUrl.pathname).toBe(`/update/${UPDATE}/--/auth/callback`);
    expect(updateUrl.searchParams.get("runtime-version")).toBe("0.1.0");
    expect(updateUrl.searchParams.get("exchange_code")).toBe("code-1");
    expect(withCode).toContain("&exchange_code=code-1");
    expect(withCode.includes("?exchange_code=")).toBe(false);
  });
});
