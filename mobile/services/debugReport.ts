import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";
import { AI_PHOTO_CONSENT_VERSION } from "@fitlogr/shared";
import nativeClassifier from "../modules/photo-classifier";
import { openFitlogrDatabase, readMode, readSetting } from "./db";
import { formatDebugLines, readDebugLog } from "./debugLog";
import { listPasses } from "./engine/activity";
import { CLASSIFIER_POLICY_VERSION } from "./engine/classifier";
import { readHealthConnection } from "./health";
import { libraryAccess } from "./photos/library";
import { readSession } from "./session";

export interface BuildInfo {
  version: string;
  commit: string | null;
  profile: string | null;
  builtAt: string | null;
}

export function buildInfo(): BuildInfo {
  const extra = (Constants.expoConfig?.extra ?? {}) as { buildCommit?: unknown; buildProfile?: unknown; builtAt?: unknown };
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    version: Constants.expoConfig?.version ?? "?",
    commit: text(extra.buildCommit),
    profile: text(extra.buildProfile),
    builtAt: text(extra.builtAt),
  };
}

/** "0.2.1 · a1b2c3d". The commit is what tells two builds of the same version apart. */
export function buildLabel(): string {
  const info = buildInfo();
  return info.commit ? `${info.version} · ${info.commit.slice(0, 7)}` : info.version;
}

const SETTINGS_SHOWN = [
  "setup_done",
  "ai_photo_consent_pending",
  "photo_history_days",
  "photo_resume_at",
  "health_history_days",
  "health_synced_at",
  "last_synced_at",
  "sync_cursor",
  "notify_meals",
  "notify_used_up",
  "used_up_date",
];

/** One section at a time, so a section that fails says so instead of losing the whole report. */
async function section(title: string, lines: string[], fill: () => Promise<string[]>): Promise<void> {
  lines.push("", `## ${title}`);
  try {
    lines.push(...(await fill()));
  } catch (error) {
    lines.push(`(could not read: ${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Everything needed to diagnose the app from a distance, as plain text: what was built, what the
 * phone allows, where each photo stands, and the recent log. No token, email or photo is included.
 */
export async function buildDebugReport(logLines = 600): Promise<string> {
  const info = buildInfo();
  const lines: string[] = ["# fitlogr debug report"];
  const now = new Date();
  lines.push(`generated: ${now.toISOString()} (local ${now.toLocaleString()})`);

  await section("Build", lines, async () => [
    `version: ${info.version}`,
    `commit: ${info.commit ?? "unknown (not an EAS build)"}`,
    `profile: ${info.profile ?? "unknown"} · built ${info.builtAt ?? "unknown"}`,
    `update: ${Updates.isEmbeddedLaunch ? "none, running the JavaScript built into the app" : `over-the-air update ${Updates.updateId ?? "?"}`}`,
    `channel: ${Updates.channel ?? "none"} · runtime ${Updates.runtimeVersion ?? "?"}`,
    `platform: ${Platform.OS} ${String(Platform.Version)} · app state ${AppState.currentState}`,
    `ownership: ${Constants.executionEnvironment}`,
  ]);

  await section("Classifier", lines, async () => {
    if (!nativeClassifier) {
      return [
        "native module: MISSING. Automatic photo scanning cannot run in this build.",
        "The build was made from a commit where the classifier is not linked. Rebuild from the fixed branch.",
      ];
    }
    let labels = 0;
    try {
      labels = nativeClassifier.supportedLabels().length;
    } catch {
      labels = -1;
    }
    return [`native module: linked (apple-vision) · policy ${CLASSIFIER_POLICY_VERSION}`, `labels this iOS version can emit: ${labels < 0 ? "call failed" : labels}`];
  });

  const db = await openFitlogrDatabase();

  await section("Account and permissions", lines, async () => {
    const session = await readSession();
    const consent = await readSetting(db, "ai_photo_consent_version");
    const out = [
      `mode: ${await readMode(db)}`,
      `session: ${session.refreshToken ? "present" : "none"} · access token expires ${session.expiresAt ?? "?"}`,
      `photo analysis consent: ${consent === AI_PHOTO_CONSENT_VERSION ? "agreed" : `not agreed (stored "${consent ?? ""}", current "${AI_PHOTO_CONSENT_VERSION}")`}`,
    ];
    try {
      out.push(`photo library access: ${await libraryAccess(false)}`);
    } catch (error) {
      out.push(`photo library access: could not read (${error instanceof Error ? error.message : String(error)})`);
    }
    try {
      const notifications = await Notifications.getPermissionsAsync();
      out.push(`notifications: ${notifications.status}`);
    } catch {
      out.push("notifications: could not read");
    }
    try {
      const health = await readHealthConnection(db);
      out.push(`apple health: ${health.connected ? "connected" : "not connected"} · permission ${health.permission} · ${health.message ?? ""}`);
    } catch (error) {
      out.push(`apple health: could not read (${error instanceof Error ? error.message : String(error)})`);
    }
    return out;
  });

  await section("Settings", lines, async () => {
    const out: string[] = [];
    for (const key of SETTINGS_SHOWN) out.push(`${key}: ${(await readSetting(db, key)) ?? "(unset)"}`);
    return out;
  });

  await section("Changes waiting to sync", lines, async () => {
    const rows = await db.getAllAsync<{ method: string; path: string; retry_count: number; next_retry_at: string | null; created_at: string }>(
      "SELECT method, path, retry_count, next_retry_at, created_at FROM sync_outbox ORDER BY created_at LIMIT 30",
    );
    if (rows.length === 0) return ["none"];
    return rows.map((row) => `${row.method} ${row.path} · created ${row.created_at} · tries ${row.retry_count} · next ${row.next_retry_at ?? "now"}`);
  });

  await section("Photo log totals", lines, async () => {
    const states = await db.getAllAsync<{ scan_status: string; n: number }>(
      "SELECT scan_status, COUNT(*) AS n FROM local_media_assets GROUP BY scan_status ORDER BY n DESC",
    );
    const verdicts = await db.getAllAsync<{ verdict: string | null; n: number }>(
      "SELECT verdict, COUNT(*) AS n FROM local_media_assets GROUP BY verdict ORDER BY n DESC",
    );
    const errors = await db.getAllAsync<{ last_error: string; n: number }>(
      "SELECT last_error, COUNT(*) AS n FROM local_media_assets WHERE last_error IS NOT NULL AND last_error != '' GROUP BY last_error ORDER BY n DESC LIMIT 8",
    );
    const meals = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM meals");
    return [
      `by AI state: ${states.map((row) => `${row.scan_status} ${row.n}`).join(", ") || "no photos yet"}`,
      `by on-device verdict: ${verdicts.map((row) => `${row.verdict ?? "none"} ${row.n}`).join(", ") || "no photos yet"}`,
      `meals on this phone: ${meals?.n ?? 0}`,
      ...errors.map((row) => `error x${row.n}: ${row.last_error}`),
    ];
  });

  await section("Recent passes (newest first)", lines, async () => {
    const passes = await listPasses(db);
    if (passes.length === 0) return ["none recorded"];
    return passes.slice(0, 25).map((pass) => {
      const counts = pass.counts
        ? ` · checked ${pass.counts.checked}, food-like ${pass.counts.lookLikeFood}, analysed ${pass.counts.analysed}, meals ${pass.counts.meals}, waiting ${pass.counts.waiting}, errors ${pass.counts.errors}`
        : " · no photo step";
      return `${pass.ranAt} ${pass.reason} · ${Math.round(pass.durationMs / 100) / 10}s${counts}${pass.error ? ` · ERROR ${pass.error}` : ""}`;
    });
  });

  await section(`Log (last ${logLines} lines, oldest first, times in UTC)`, lines, async () => {
    const log = await readDebugLog(logLines);
    return log.length ? [formatDebugLines(log)] : ["empty"];
  });

  return lines.join("\n");
}
