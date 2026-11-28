import type { Env } from "../env";
import { ApiError } from "../http";
import { nowIso } from "../ids";
import { googleFetch, GOOGLE_RECONNECT, markRevoked } from "./tokens";

const PHOTOS_API = "https://photoslibrary.googleapis.com/v1";

export interface UploadedMealPhoto {
  albumId: string;
  mediaItemId: string;
}

export async function uploadMealPhoto(
  db: D1Database,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch,
  now: Date,
  image: Uint8Array,
  description: string,
  fileName: string,
): Promise<UploadedMealPhoto> {
  let albumId = await ensureAlbum(db, env, userId, fetchImpl, now);
  const uploadToken = await uploadBytes(db, env, userId, fetchImpl, now, image);
  try {
    const mediaItemId = await batchCreate(db, env, userId, fetchImpl, now, albumId, uploadToken, description, fileName);
    return { albumId, mediaItemId };
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "ALBUM_MISSING") throw error;
    await db.prepare("DELETE FROM user_google_photos WHERE user_id = ?").bind(userId).run();
    albumId = await ensureAlbum(db, env, userId, fetchImpl, now, true);
    try {
      const mediaItemId = await batchCreate(db, env, userId, fetchImpl, now, albumId, uploadToken, description, fileName);
      return { albumId, mediaItemId };
    } catch (retryError) {
      if (retryError instanceof ApiError && retryError.code === "ALBUM_MISSING") {
        throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google Photos could not save the photo");
      }
      throw retryError;
    }
  }
}

export async function fetchMealPhotoUrl(
  db: D1Database,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch,
  now: Date,
  mediaItemId: string,
): Promise<{ url: string } | { missing: true } | { quota: true }> {
  const response = await googleFetch(db, env, userId, fetchImpl, now, `${PHOTOS_API}/mediaItems/${encodeURIComponent(mediaItemId)}`);
  if (response.status === 404) return { missing: true };
  if (response.status === 429) return { quota: true };
  if (!response.ok) {
    const detail = await readError(response);
    if (isRateLimit(response.status, detail) || isStorageFull(detail)) return { quota: true };
    if (response.status === 401 || response.status === 403) {
      await markRevoked(db, userId, now);
      throw new ApiError(403, GOOGLE_RECONNECT, "Google Photos access was revoked. Reconnect Google to keep saving meal photos.");
    }
    throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google Photos could not be reached");
  }
  const payload = (await response.json()) as { baseUrl?: unknown };
  if (typeof payload.baseUrl !== "string" || payload.baseUrl.length === 0) {
    return { missing: true };
  }
  return { url: displayUrl(payload.baseUrl) };
}

export function displayUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/=[^/=]*$/, "");
  return `${trimmed}=w1080-h1080`;
}

export function urlExpiresAt(now: Date): string {
  return new Date(now.getTime() + 45 * 60 * 1000).toISOString();
}

async function ensureAlbum(
  db: D1Database,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch,
  now: Date,
  skipCache = false,
): Promise<string> {
  if (!skipCache) {
    const existing = await db
      .prepare("SELECT album_id FROM user_google_photos WHERE user_id = ? AND status = 'active'")
      .bind(userId)
      .first<{ album_id: string }>();
    if (existing?.album_id) return existing.album_id;
  }
  const title = env.GOOGLE_PHOTOS_ALBUM_NAME || "fitlogr";
  const found = await findAlbum(db, env, userId, fetchImpl, now, title);
  const album = found ?? (await createAlbum(db, env, userId, fetchImpl, now, title));
  const stamp = nowIso(now);
  await db
    .prepare(
      `INSERT INTO user_google_photos (user_id, album_id, album_title, product_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         album_id = excluded.album_id,
         album_title = excluded.album_title,
         product_url = excluded.product_url,
         status = 'active',
         updated_at = excluded.updated_at`,
    )
    .bind(userId, album.id, album.title, album.productUrl, stamp, stamp)
    .run();
  return album.id;
}

async function findAlbum(
  db: D1Database,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch,
  now: Date,
  title: string,
): Promise<{ id: string; title: string; productUrl: string | null } | null> {
  let pageToken = "";
  for (let page = 0; page < 5; page += 1) {
    const url = new URL(`${PHOTOS_API}/albums`);
    url.searchParams.set("pageSize", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await googleFetch(db, env, userId, fetchImpl, now, url.toString());
    if (response.status === 404) return null;
    if (!response.ok) throw await googleFailure(db, userId, now, response);
    const payload = (await response.json()) as {
      albums?: Array<{ id?: string; title?: string; productUrl?: string }>;
      nextPageToken?: string;
    };
    const match = payload.albums?.find((album) => album.title === title && album.id);
    if (match?.id) return { id: match.id, title, productUrl: match.productUrl ?? null };
    if (!payload.nextPageToken) return null;
    pageToken = payload.nextPageToken;
  }
  return null;
}

async function createAlbum(
  db: D1Database,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch,
  now: Date,
  title: string,
): Promise<{ id: string; title: string; productUrl: string | null }> {
  const response = await googleFetch(db, env, userId, fetchImpl, now, `${PHOTOS_API}/albums`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ album: { title } }),
  });
  if (!response.ok) throw await googleFailure(db, userId, now, response);
  const payload = (await response.json()) as { id?: string; title?: string; productUrl?: string };
  if (!payload.id) throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google Photos could not create the fitlogr album");
  return { id: payload.id, title: payload.title || title, productUrl: payload.productUrl ?? null };
}

async function uploadBytes(
  db: D1Database,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch,
  now: Date,
  image: Uint8Array,
): Promise<string> {
  const response = await googleFetch(db, env, userId, fetchImpl, now, `${PHOTOS_API}/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-goog-upload-content-type": "image/jpeg",
      "x-goog-upload-protocol": "raw",
    },
    body: copyBuffer(image),
  });
  if (!response.ok) throw await googleFailure(db, userId, now, response);
  const token = (await response.text()).trim();
  if (!token) throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google Photos did not accept the photo");
  return token;
}

async function batchCreate(
  db: D1Database,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch,
  now: Date,
  albumId: string,
  uploadToken: string,
  description: string,
  fileName: string,
): Promise<string> {
  const response = await googleFetch(db, env, userId, fetchImpl, now, `${PHOTOS_API}/mediaItems:batchCreate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      albumId,
      newMediaItems: [{ description, simpleMediaItem: { uploadToken, fileName } }],
    }),
  });
  if (!response.ok) {
    const detail = await readError(response);
    if (response.status === 400 || response.status === 404) {
      if (/album/i.test(detail.message) || /album/i.test(detail.reason)) {
        throw new ApiError(400, "ALBUM_MISSING", "The fitlogr album is missing");
      }
    }
    const error = failureFrom(response.status, detail);
    if (error.code === GOOGLE_RECONNECT) await markRevoked(db, userId, now);
    throw error;
  }
  const payload = (await response.json()) as {
    newMediaItemResults?: Array<{ mediaItem?: { id?: string }; status?: { message?: string; code?: number } }>;
  };
  const result = payload.newMediaItemResults?.[0];
  if (result?.mediaItem?.id) return result.mediaItem.id;
  const message = result?.status?.message ?? "";
  if (isStorageFull({ message, reason: "" })) {
    throw new ApiError(403, "GOOGLE_QUOTA_EXCEEDED", "Google Photos storage is full");
  }
  if (isRateLimit(0, { message, reason: "" })) {
    throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google Photos is busy. fitlogr will retry the upload.");
  }
  if (/album/i.test(message)) throw new ApiError(400, "ALBUM_MISSING", "The fitlogr album is missing");
  throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google Photos did not save the photo");
}

async function googleFailure(db: D1Database, userId: string, now: Date, response: Response): Promise<ApiError> {
  const error = failureFrom(response.status, await readError(response));
  if (error.code === GOOGLE_RECONNECT) await markRevoked(db, userId, now);
  return error;
}

function failureFrom(status: number, detail: GoogleErrorDetail): ApiError {
  // A request-rate limit passes, so it is an upstream error the app retries, not a full library.
  if (isRateLimit(status, detail)) return new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google Photos is busy. fitlogr will retry the upload.");
  if (isStorageFull(detail)) return new ApiError(403, "GOOGLE_QUOTA_EXCEEDED", "Google Photos storage is full");
  if (status === 401 || status === 403) {
    return new ApiError(403, GOOGLE_RECONNECT, "Google Photos access was revoked. Reconnect Google to keep saving meal photos.");
  }
  return new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google Photos could not be reached");
}

interface GoogleErrorDetail {
  message: string;
  reason: string;
}

async function readError(response: Response): Promise<GoogleErrorDetail> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: { message?: string; status?: string; errors?: Array<{ reason?: string }> } };
    return {
      message: body.error?.message ?? "",
      reason: body.error?.status ?? body.error?.errors?.[0]?.reason ?? "",
    };
  } catch {
    return { message: text.slice(0, 300), reason: "" };
  }
}

/** Google API request quotas ("Quota exceeded for quota metric ... per minute", RESOURCE_EXHAUSTED, HTTP 429). */
function isRateLimit(status: number, detail: GoogleErrorDetail): boolean {
  if (status === 429) return true;
  const text = `${detail.reason} ${detail.message}`;
  if (isStorageFull(detail)) return false;
  return /RESOURCE_EXHAUSTED|rateLimitExceeded|quota metric|per minute|per day|too many requests|quota exceeded/i.test(text);
}

/** The person's Google account is out of storage. */
function isStorageFull(detail: GoogleErrorDetail): boolean {
  return /storage (?:quota|is full|full|limit)|insufficient storage|out of storage|storageQuotaExceeded/i.test(`${detail.reason} ${detail.message}`);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
