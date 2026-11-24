import Constants, { ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";
import { EXPO_GO_EXECUTION_ENVIRONMENT, resolveHealthProviderKind } from "@fitlogr/shared";
import { HealthConnectProvider } from "./health-connect";
import { HealthKitProvider, loadHealthKitModule } from "./healthkit";
import type { HealthProvider } from "./types";
import { unsupportedProvider } from "./unsupported";

let cached: HealthProvider | null = null;

/** Resolves a provider without evaluating HealthKit inside Expo Go. */
export function getHealthProvider(): HealthProvider {
  if (cached) return cached;
  const executionEnvironment = Constants.executionEnvironment ?? null;
  const os = Platform.OS;
  if (os === "ios" && executionEnvironment === ExecutionEnvironment.StoreClient) {
    cached = unsupportedProvider(os, EXPO_GO_EXECUTION_ENVIRONMENT);
    return cached;
  }
  const kind = resolveHealthProviderKind({
    os,
    executionEnvironment,
    nativeModuleLoaded: os === "ios",
  });
  if (kind === "healthkit") {
    const native = loadHealthKitModule();
    cached = native ? new HealthKitProvider(native) : unsupportedProvider(os, executionEnvironment);
    return cached;
  }
  if (kind === "health_connect") {
    cached = new HealthConnectProvider();
    return cached;
  }
  cached = unsupportedProvider(os, executionEnvironment);
  return cached;
}
