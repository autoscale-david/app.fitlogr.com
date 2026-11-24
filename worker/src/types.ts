import type { Env } from "./env";
import type { AuthContext } from "./auth/sessions";

export interface AppDeps {
  fetch: typeof fetch;
  now: () => Date;
}

export type AppVariables = {
  requestId: string;
  deps: AppDeps;
  auth?: AuthContext;
};

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
