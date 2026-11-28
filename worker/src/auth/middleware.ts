import type { MiddlewareHandler } from "hono";
import { requireAuthConfig } from "../config";
import { authenticate } from "./sessions";
import { requireDb } from "../http";
import type { AppEnv } from "../types";

export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = requireAuthConfig(c.env);
    const auth = await authenticate(requireDb(c.env.DB), c.req.header("authorization"), config.sessionSecret, c.get("deps").now());
    c.set("auth", auth);
    await next();
  };
}

export function currentAuth(auth: AppEnv["Variables"]["auth"]) {
  if (!auth) throw new Error("missing auth context");
  return auth;
}
