import { AppState } from "react-native";
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

/**
 * Vision returns a parent label ("food") alongside the specific ones, and a busy photo can have many
 * labels above the floor. Keep enough of them that a food label is not cut off by the list length.
 */
const MAX_LABELS = 40;
const MIN_CONFIDENCE = 0.05;
/** A photo that never answers must not hang the pass: every later pass would wait on it. */
const CLASSIFY_TIMEOUT_MS = 20_000;

const native: PhotoClassifierNative | null = nativeModule ?? null;

/** iOS does not let a backgrounded app use the GPU, so Vision is told to stay on the CPU there. */
function cpuOnly(): boolean {
  return AppState.currentState !== "active";
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
        const [first] = await withTimeout(native.classifyAssets([assetId], MAX_LABELS, MIN_CONFIDENCE, cpuOnly()));
        if (!first) return { error: "Classifier returned nothing" };
        if (first.error) return { error: first.error };
        return { labels: first.labels ?? [] };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Classifier failed" };
      }
    },
    async classifyFile(uri) {
      try {
        const result = await withTimeout(native.classifyFile(uri, MAX_LABELS, MIN_CONFIDENCE, cpuOnly()));
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

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The photo took too long to load")), CLASSIFY_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Asks iOS for about 30 seconds of background time, runs `work`, then gives the time back. Without
 * this iOS suspends a background-woken app within seconds, in the middle of an upload.
 */
export async function withBackgroundTime<T>(name: string, work: () => Promise<T>): Promise<T> {
  let id: number | null = null;
  try {
    id = native ? await native.beginBackgroundWork(name) : null;
  } catch {
    id = null;
  }
  try {
    return await work();
  } finally {
    if (native && id !== null) await native.endBackgroundWork(id).catch(() => undefined);
  }
}

export function decideLabels(labels: PipelineLabel[]): { verdict: string; send: boolean } {
  const result = triage(labels as TriageLabel[], PHOTO_TRIAGE_POLICY);
  return { verdict: result.verdict, send: sendsForAnalysis(result.verdict, PHOTO_TRIAGE_POLICY) };
}

export const CLASSIFIER_POLICY_VERSION = PHOTO_TRIAGE_POLICY.version;
