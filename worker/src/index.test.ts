import { describe, expect, it } from "vitest";
import app from "./index";

describe("GET /api/health", () => {
  it("reports the database as ready when SELECT 1 succeeds", async () => {
    const response = await app.request(
      "https://fitlogr.com/api/health",
      {},
      {
        ENVIRONMENT: "test",
        DB: {
          prepare() {
            return {
              async first() {
                return { ok: 1 };
              },
            };
          },
        },
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      version: "0.1.0",
      db_ok: true,
      environment: "test",
    });
  });

  it("stays up when D1 is not bound yet", async () => {
    const response = await app.request("https://fitlogr.com/api/health", {}, { ENVIRONMENT: "test" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.db_ok).toBe(false);
  });

  it("returns a JSON 404 for unknown API routes", async () => {
    const response = await app.request("https://fitlogr.com/api/missing", {}, {});
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
