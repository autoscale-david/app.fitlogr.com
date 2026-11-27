import { PHOTO_TRIAGE_POLICY, sendsForAnalysis, triage, type TriageLabel } from "@fitlogr/shared";
import nativeModule, { type PhotoClassifierNative } from "../../modules/photo-classifier";
import type { PipelineLabel } from "./pipeline";

export interface PhotoClassifier {
  id: string;
  /** False in Expo Go, on Android, and when the native module failed to load. Automatic scanning stays off. */
  available: boolean;
  classifyAsset(assetId: string): Promise<{ labels: PipelineLabel[] } | { error: string }>;
  classifyFile(uri: string): Promise<{ labels: PipelineLabel[] } | { error: string }>;
  supportedLabels(): string[];
}

const OPTIONS = { maxLabels: 8, minConfidence: 0.05 };

const native: PhotoClassifierNative | null = loadNative();

function loadNative(): PhotoClassifierNative | null {
  try {
    return nativeModule;
  } catch {
    return null;
  }
}

/** Apple Vision when the native module is in the binary. Otherwise automatic scanning is off. */
export function getClassifier(): PhotoClassifier {
  if (!native) {
    return {
      id: "unavailable",
      available: false,
      async classifyAsset() {
        return { error: "On-device classifier is not installed" };
      },
      async classifyFile() {
        return { error: "On-device classifier is not installed" };
      },
      supportedLabels: () => [],
    };
  }
  return {
    id: "apple-vision",
    available: true,
    async classifyAsset(assetId) {
      try {
        const [first] = await native.classifyAssets([assetId], OPTIONS);
        if (!first) return { error: "Classifier returned nothing" };
        if (first.error) return { error: first.error };
        return { labels: first.labels ?? [] };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Classifier failed" };
      }
    },
    async classifyFile(uri) {
      try {
        const result = await native.classifyFile(uri, OPTIONS);
        if (result.error) return { error: result.error };
        return { labels: result.labels ?? [] };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Classifier failed" };
      }
    },
    supportedLabels() {
      try {
        return native.supportedLabels();
      } catch {
        return [];
      }
    },
  };
}

export function decideLabels(labels: PipelineLabel[]): { verdict: string; send: boolean } {
  const result = triage(labels as TriageLabel[], PHOTO_TRIAGE_POLICY);
  return { verdict: result.verdict, send: sendsForAnalysis(result.verdict, PHOTO_TRIAGE_POLICY) };
}

export const CLASSIFIER_POLICY_VERSION = PHOTO_TRIAGE_POLICY.version;
