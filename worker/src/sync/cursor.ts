import { base64UrlToJson, jsonToBase64Url } from "../encoding";
import { ApiError } from "../http";

export interface SyncCursor {
  t: string;
  id: string;
}

const START: SyncCursor = { t: "1970-01-01T00:00:00.000Z", id: "" };

export function decodeCursor(since: string | undefined): SyncCursor {
  if (!since || since === "0") return START;
  try {
    const parsed = base64UrlToJson(since);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "t" in parsed &&
      "id" in parsed &&
      typeof parsed.t === "string" &&
      typeof parsed.id === "string" &&
      parsed.t.length > 0 &&
      parsed.id.length <= 80
    ) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // Fall through to the validation error.
  }
  throw new ApiError(400, "VALIDATION_ERROR", "Sync cursor is not valid");
}

export function encodeCursor(cursor: SyncCursor): string {
  return jsonToBase64Url(cursor);
}
