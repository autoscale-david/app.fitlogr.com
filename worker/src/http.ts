import type { ZodType } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function errorBody(code: string, message: string, requestId?: string) {
  return {
    error: {
      code,
      message,
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
}

export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "Request body must be JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request");
  }
  return parsed.data;
}

export function readQuery<T>(query: Record<string, string | undefined>, schema: ZodType<T>): T {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid query");
  }
  return parsed.data;
}

export function jsonError(requestId: string | undefined, error: ApiError) {
  return { body: errorBody(error.code, error.message, requestId), status: error.status as 400 };
}

export function requireDb(db: D1Database | undefined): D1Database {
  if (!db) throw new ApiError(503, "INTERNAL_ERROR", "Database is not available");
  return db;
}
