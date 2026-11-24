import type { Hono } from "hono";
import { CheckHashesRequestSchema, PhotoExcludeRequestSchema } from "@fitlogr/shared";
import { currentAuth, requireAuth } from "../auth/middleware";
import { ApiError, errorBody, readJson, requireDb } from "../http";
import type { AppEnv } from "../types";
import { RateLimitError, analyzeUploadedPhoto, checkPhotoHashes, excludePhoto, freshPhotoUrl } from "./service";

export function registerPhotoRoutes(app: Hono<AppEnv>): void {
  app.post("/api/photos/check-hashes", requireAuth(), async (c) => {
    const body = await readJson(c.req.raw, CheckHashesRequestSchema);
    const result = await checkPhotoHashes(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, body.items);
    return c.json(result);
  });

  app.post("/api/photos/analyze", requireAuth(), async (c) => {
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw new ApiError(400, "VALIDATION_ERROR", "Photo upload must be multipart form data");
    }
    const image = form.get("image");
    if (!(image instanceof File)) throw new ApiError(400, "VALIDATION_ERROR", "image is required");
    const metadata = await readMetadata(form.get("metadata"));
    try {
      const result = await analyzeUploadedPhoto(
        requireDb(c.env.DB),
        c.env,
        c.get("deps"),
        currentAuth(c.get("auth")).userId,
        { bytes: new Uint8Array(await image.arrayBuffer()), type: image.type },
        metadata,
      );
      return c.json(result.body, result.status);
    } catch (error) {
      if (error instanceof RateLimitError) {
        return c.json(errorBody(error.code, error.message, c.get("requestId")), 429, { "retry-after": String(error.retryAfter) });
      }
      throw error;
    }
  });

  app.get("/api/photos/:id/url", requireAuth(), async (c) => {
    const result = await freshPhotoUrl(requireDb(c.env.DB), c.env, c.get("deps"), currentAuth(c.get("auth")).userId, c.req.param("id"));
    return c.json(result);
  });

  app.post("/api/photos/:id/exclude", requireAuth(), async (c) => {
    await readExcludeBody(c.req.raw);
    const result = await excludePhoto(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, c.req.param("id"), c.get("deps").now());
    return c.json(result);
  });
}

async function readMetadata(value: File | string | null): Promise<unknown> {
  try {
    if (typeof value === "string") return JSON.parse(value);
    if (value instanceof File) return JSON.parse(await value.text());
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "metadata must be JSON");
  }
  throw new ApiError(400, "VALIDATION_ERROR", "metadata is required");
}

async function readExcludeBody(request: Request): Promise<void> {
  const text = await request.text();
  if (!text.trim()) {
    PhotoExcludeRequestSchema.parse({});
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "Request body must be JSON");
  }
  const parsed = PhotoExcludeRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request");
}
