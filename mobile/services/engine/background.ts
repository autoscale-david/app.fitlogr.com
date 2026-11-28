import { AppState, Platform } from "react-native";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
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

// Module scope so a headless HealthKit launch registers observers before React mounts.
if (Platform.OS === "ios") {
  const kit = loadHealthKitModule() as (ReturnType<typeof loadHealthKitModule> & BackgroundKit) | null;
  if (kit?.enableBackgroundDelivery && kit.subscribeToChanges) {
    const wake = () => {
      void runPass({ reason: "healthkit", active: AppState.currentState === "active" });
    };
    for (const identifier of HOURLY_TYPES) {
      void kit.enableBackgroundDelivery(identifier, HOURLY).catch(() => undefined);
      kit.subscribeToChanges(identifier, wake);
    }
    for (const identifier of IMMEDIATE_TYPES) {
      void kit.enableBackgroundDelivery(identifier, IMMEDIATE).catch(() => undefined);
      kit.subscribeToChanges(identifier, wake);
    }
  }
}

TaskManager.defineTask(PASS_TASK, async () => {
  try {
    await runPass({ reason: "background-task", active: false });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Registers the iOS background refresh once setup has consent. Safe to call again. */
export async function registerBackgroundPass(): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return;
    await BackgroundTask.registerTaskAsync(PASS_TASK, { minimumInterval: 15 });
  } catch {
    // Expo Go and a missing entitlement leave the pass to the next foreground open.
  }
}
