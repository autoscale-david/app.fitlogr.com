import { requireOptionalNativeModule } from "expo";

export interface NativeLabel {
  id: string;
  confidence: number;
}

export interface NativeClassification {
  assetId: string;
  labels?: NativeLabel[];
  error?: string;
}

export interface PhotoClassifierNative {
  /** `cpuOnly` must be true when the app is not active: iOS denies GPU work in the background. */
  classifyAssets(assetIds: string[], maxLabels: number, minConfidence: number, cpuOnly: boolean): Promise<NativeClassification[]>;
  classifyFile(uri: string, maxLabels: number, minConfidence: number, cpuOnly: boolean): Promise<NativeClassification>;
  supportedLabels(): string[];
  /** Asks iOS for about 30 more seconds of background time. Pass the id to `endBackgroundWork`. */
  beginBackgroundWork(name: string): Promise<number>;
  endBackgroundWork(id: number): Promise<void>;
}

export default requireOptionalNativeModule<PhotoClassifierNative>("PhotoClassifier");
