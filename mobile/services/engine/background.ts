import { AppState, Platform } from "react-native";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { debugLog, describeError } from "../debugLog";
import { loadHealthKitModule } from "../health/healthkit";
import { runPass } from "./runPass";

export const PASS_TASK = "fitlogr-pass";

// Verified in @react-native-healthkit/core: immediate = 1, hourly = 2.
const IMMEDIATE = 1;
const HOURLY = 2;
const HOURLY_TYPES = ["HKQuantityTypeIdentifierActiveEnergyBurned", "HKQuantityTypeIdentifierStepCount"];
const IMMEDIATE_TYPES = ["HKWorkoutTypeIdentifier", "HKQuantityTypeIdentifierBodyMass"];

interface BackgroundKit {
  /**
   * Saves the types natively and registers their observers when the app launches, before any
   * JavaScript runs. Apple requires that for a wake-up to reach an app it had terminated.
   * Verified in @kingstinct/react-native-healthkit: (identifiers, frequency) => Promise<boolean>.
   */
  configureBackgroundTypes?: (identifiers: string[], frequency: number) => Promise<boolean>;
  enableBackgroundDelivery?: (identifier: string, frequency: number) => Promise<boolean>;
  subscribeToChanges?: (identifier: string, callback: () => void) => { remove: () => void };
}

let subscriptions: { remove: () => void }[] = [];
let reportedRestricted = false;
let arming = 0;
/** Each arm waits for the one before it, so an older native set-up can never undo a newer one. */
let armChain: Promise<void> = Promise.resolve();

function shortType(identifier: string): string {
  return identifier.replace(/^HK(Quantity|Workout)?TypeIdentifier/, "") || "Workout";
}

/**
 * Turns on Apple Health background delivery and watches for new samples. iOS then wakes the app
 * (about hourly for a watch wearer, at once for a workout) and each wake runs one short pass.
 * Called when the JavaScript loads, and again right after the person grants Apple Health access:
 * observers registered before access was granted never fire. Never asks for permission itself.
 */
export function armHealthWake(): void {
  try {
    armHealthWakeUnguarded();
  } catch (error) {
    // This runs when the JavaScript loads. Nothing here may stop the rest of the app from starting.
    debugLog("wake", `Apple Health background delivery could not be set up: ${describeError(error)}`);
  }
}

function armHealthWakeUnguarded(): void {
  if (Platform.OS !== "ios") return;
  const kit = loadHealthKitModule() as (ReturnType<typeof loadHealthKitModule> & BackgroundKit) | null;
  if (!kit?.subscribeToChanges) {
    debugLog("wake", "Apple Health background delivery is not available in this build");
    return;
  }
  const generation = (arming += 1);
  // HealthKit also reports once at every launch. With the app open that is an ordinary foreground pass.
  const wake = (identifier: string) => {
    const active = AppState.currentState === "active";
    debugLog("wake", `Apple Health reported ${shortType(identifier)} · app ${AppState.currentState}`);
    void runPass({ reason: active ? "foreground" : "healthkit", active });
  };
  const subscribe = (path: string) => {
    // A later call (after access was granted) replaces this one.
    if (generation !== arming) return;
    for (const subscription of subscriptions) {
      try {
        subscription.remove();
      } catch {
        // Already gone.
      }
    }
    subscriptions = [];
    for (const identifier of [...HOURLY_TYPES, ...IMMEDIATE_TYPES]) {
      try {
        const subscription = kit.subscribeToChanges?.(identifier, () => wake(identifier));
        if (subscription) subscriptions.push(subscription);
      } catch (error) {
        // Apple Health is unavailable or access was not granted yet. Setup arms this again.
        debugLog("wake", `could not watch ${shortType(identifier)}: ${describeError(error)}`);
      }
    }
    debugLog("wake", `watching ${subscriptions.length} Apple Health types (${path}) · app ${AppState.currentState}`);
  };

  const configure = kit.configureBackgroundTypes;
  if (configure) {
    armChain = armChain
      .then(async () => {
        if (generation !== arming) return;
        try {
          // One frequency for all types. iOS itself limits steps and active energy to about hourly.
          await configure([...HOURLY_TYPES, ...IMMEDIATE_TYPES], IMMEDIATE);
          subscribe("native observers");
        } catch (error) {
          debugLog("wake", `native background observers could not be set up: ${describeError(error)}`);
          subscribe("session observers");
        }
      })
      .catch(() => undefined);
    return;
  }
  // Older library: per-type delivery, with observers that only live as long as this process.
  for (const [identifiers, frequency] of [
    [HOURLY_TYPES, HOURLY],
    [IMMEDIATE_TYPES, IMMEDIATE],
  ] as const) {
    for (const identifier of identifiers) {
      void kit
        .enableBackgroundDelivery?.(identifier, frequency)
        .then((enabled) => {
          if (!enabled) debugLog("wake", `background delivery for ${shortType(identifier)} was not enabled`);
        })
        .catch((error: unknown) => debugLog("wake", `background delivery for ${shortType(identifier)} failed: ${describeError(error)}`));
    }
  }
  subscribe("session observers");
}

// Module scope, and imported by the entry file, so a launch with nothing on screen still registers these.
armHealthWake();

TaskManager.defineTask(PASS_TASK, async () => {
  debugLog("wake", `iOS background task fired · app ${AppState.currentState}`);
  try {
    await runPass({ reason: "background-task", active: false });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (error) {
    debugLog("wake", `background task failed: ${describeError(error)}`);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Registers the iOS background refresh once setup has consent. Safe to call again. */
export async function registerBackgroundPass(): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) {
      if (!reportedRestricted) debugLog("wake", "iOS background refresh is restricted (Low Power Mode, or Background App Refresh is off)");
      reportedRestricted = true;
      return;
    }
    reportedRestricted = false;
    await BackgroundTask.registerTaskAsync(PASS_TASK, { minimumInterval: 15 });
  } catch (error) {
    // Expo Go and a missing entitlement leave the pass to the next foreground open.
    debugLog("wake", `background task could not be registered: ${describeError(error)}`);
  }
}
