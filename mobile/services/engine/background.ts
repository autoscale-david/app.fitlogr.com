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
  enableBackgroundDelivery?: (identifier: string, frequency: number) => Promise<boolean>;
  subscribeToChanges?: (identifier: string, callback: () => void) => { remove: () => void };
}

let subscriptions: { remove: () => void }[] = [];
let reportedRestricted = false;

/**
 * Turns on Apple Health background delivery and watches for new samples. iOS then wakes the app
 * (about hourly for a watch wearer, at once for a workout) and each wake runs one short pass.
 * Called at launch, and again right after the person grants Apple Health access: observers
 * registered before access was granted never fire. Never asks for permission itself.
 */
export function armHealthWake(): void {
  if (Platform.OS !== "ios") return;
  const kit = loadHealthKitModule() as (ReturnType<typeof loadHealthKitModule> & BackgroundKit) | null;
  if (!kit?.enableBackgroundDelivery || !kit.subscribeToChanges) {
    debugLog("wake", "Apple Health background delivery is not available in this build");
    return;
  }
  for (const subscription of subscriptions) {
    try {
      subscription.remove();
    } catch {
      // Already gone.
    }
  }
  subscriptions = [];
  // HealthKit also calls this once at every launch. With the app open that is an ordinary foreground pass.
  const short = (identifier: string) => identifier.replace(/^HK(Quantity|Workout)?TypeIdentifier/, "") || "Workout";
  const wake = (identifier: string) => {
    const active = AppState.currentState === "active";
    debugLog("wake", `Apple Health reported ${short(identifier)} · app ${AppState.currentState}`);
    void runPass({ reason: active ? "foreground" : "healthkit", active });
  };
  const watch = (identifier: string, frequency: number) => {
    try {
      void kit
        .enableBackgroundDelivery?.(identifier, frequency)
        .then((enabled) => {
          if (!enabled) debugLog("wake", `background delivery for ${short(identifier)} was not enabled`);
        })
        .catch((error: unknown) => debugLog("wake", `background delivery for ${short(identifier)} failed: ${describeError(error)}`));
      const subscription = kit.subscribeToChanges?.(identifier, () => wake(identifier));
      if (subscription) subscriptions.push(subscription);
    } catch (error) {
      // Apple Health is unavailable or access was not granted yet. Setup arms this again.
      debugLog("wake", `could not watch ${short(identifier)}: ${describeError(error)}`);
    }
  };
  for (const identifier of HOURLY_TYPES) watch(identifier, HOURLY);
  for (const identifier of IMMEDIATE_TYPES) watch(identifier, IMMEDIATE);
  debugLog("wake", `watching ${subscriptions.length} Apple Health types · app ${AppState.currentState}`);
}

// Module scope so a headless HealthKit launch registers observers before React mounts.
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
