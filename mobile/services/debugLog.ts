import { openFitlogrDatabase } from "./db";

/**
 * A running record of what the app did, kept on the phone so it can be copied out of Settings.
 * Nobody can attach a debugger to a build on a real iPhone, so this is how a failure gets explained.
 *
 * Never put a token, an email address or photo bytes in here. Photo ids are shortened.
 */
export interface DebugLine {
  at: string;
  tag: string;
  message: string;
}

const KEEP_ROWS = 2000;
const KEEP_MEMORY = 400;
const MAX_MESSAGE = 600;

const recent: DebugLine[] = [];
let unsaved: DebugLine[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();

/** Records one line. Never throws and never waits: logging must not be able to break the app. */
export function debugLog(tag: string, message: string, detail?: unknown): void {
  try {
    const text = detail === undefined ? message : `${message} ${describe(detail)}`;
    const line: DebugLine = { at: new Date().toISOString(), tag, message: text.slice(0, MAX_MESSAGE) };
    recent.push(line);
    if (recent.length > KEEP_MEMORY) recent.splice(0, recent.length - KEEP_MEMORY);
    unsaved.push(line);
    if (unsaved.length >= 25) void flushDebugLog();
    else timer ??= setTimeout(() => void flushDebugLog(), 1500);
  } catch {
    // Nothing to do: there is nowhere left to report it.
  }
}

/** Writes pending lines to the database. Called at the end of a background pass, before iOS suspends the app. */
export function flushDebugLog(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const batch = unsaved;
  unsaved = [];
  if (batch.length === 0) return saving;
  saving = saving
    .then(async () => {
      const db = await openFitlogrDatabase();
      // One statement per chunk, not a transaction: this connection is shared with the engine, and a
      // transaction here would wrap whatever the engine happened to be writing.
      for (let start = 0; start < batch.length; start += 30) {
        const chunk = batch.slice(start, start + 30);
        await db.runAsync(
          `INSERT INTO debug_log (at, tag, message) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`,
          chunk.flatMap((line) => [line.at, line.tag, line.message]),
        );
      }
      await db.runAsync("DELETE FROM debug_log WHERE id NOT IN (SELECT id FROM debug_log ORDER BY id DESC LIMIT ?)", KEEP_ROWS);
    })
    .catch(() => undefined);
  return saving;
}

/** Oldest first. Includes lines from earlier launches, which is how background wake-ups show up. */
export async function readDebugLog(limit = 800): Promise<DebugLine[]> {
  await flushDebugLog();
  try {
    const db = await openFitlogrDatabase();
    const rows = await db.getAllAsync<DebugLine>(
      "SELECT at, tag, message FROM (SELECT id, at, tag, message FROM debug_log ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
      limit,
    );
    return rows;
  } catch {
    return [...recent];
  }
}

export async function clearDebugLog(): Promise<void> {
  await flushDebugLog();
  recent.length = 0;
  try {
    const db = await openFitlogrDatabase();
    await db.runAsync("DELETE FROM debug_log");
  } catch {
    // The in-memory copy is already cleared.
  }
}

/** `ph://ABCDEF12-…/L0/001` becomes `ph:ABCDEF12`. Enough to match a row in the photo log. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "none";
  if (id.startsWith("ph://")) return `ph:${id.slice(5, 13)}`;
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-8)}` : id;
}

/** An error as one line: its name, its message, and the reason underneath it when there is one. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const because = cause === undefined || cause === null ? "" : ` (cause: ${cause instanceof Error ? cause.message : String(cause)})`;
    return `${error.name}: ${error.message}${because}`;
  }
  return typeof error === "string" ? error : describe(error);
}

function describe(value: unknown): string {
  if (value instanceof Error) return describeError(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatDebugLines(lines: readonly DebugLine[]): string {
  return lines.map((line) => `${line.at.slice(5, 23).replace("T", " ")} [${line.tag}] ${line.message}`).join("\n");
}
