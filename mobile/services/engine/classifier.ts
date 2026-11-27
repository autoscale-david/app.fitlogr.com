import type { PipelineLabel } from "./pipeline";

export interface PhotoClassifier {
  id: string;
  /** False in Expo Go and on Android until a native classifier is installed. Automatic scanning stays off. */
  available: boolean;
  classifyAsset(assetId: string): Promise<{ labels: PipelineLabel[] } | { error: string }>;
  classifyFile?(uri: string): Promise<{ labels: PipelineLabel[] } | { error: string }>;
}

/**
 * Phase 3 stand-in: every photo is treated as food so the pipeline can be tested on device
 * before the Vision module exists. Phase 4 replaces this when the native module is missing.
 */
export function getClassifier(): PhotoClassifier {
  return {
    id: "stub-pass-all",
    available: true,
    async classifyAsset() {
      return { labels: [{ id: "food", confidence: 1 }] };
    },
  };
}

export const STUB_POLICY_VERSION = "pass-all";
