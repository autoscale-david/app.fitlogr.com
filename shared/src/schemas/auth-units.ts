import { z } from "zod";

/** Kept separate so settings and the legacy unit export do not import each other in a cycle. */
export const UnitSystemSchema = z.enum(["metric", "imperial"]);
export type UnitSystem = z.infer<typeof UnitSystemSchema>;
