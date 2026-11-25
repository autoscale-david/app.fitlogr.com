import Constants, { ExecutionEnvironment } from "expo-constants";

/** True inside the Expo Go app, which lacks HealthKit and the full photo library scan. */
export function isExpoGo(): boolean {
  return Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
}
