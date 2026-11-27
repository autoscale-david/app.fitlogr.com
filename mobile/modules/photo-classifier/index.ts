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
  classifyAssets(assetIds: string[], options: { maxLabels: number; minConfidence: number }): Promise<NativeClassification[]>;
  classifyFile(uri: string, options: { maxLabels: number; minConfidence: number }): Promise<NativeClassification>;
  supportedLabels(): string[];
}

export default requireOptionalNativeModule<PhotoClassifierNative>("PhotoClassifier");
