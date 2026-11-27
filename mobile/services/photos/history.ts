export interface HistoryProgress {
  scanned: number;
  skipped: number;
  meals: number;
  nonMeals: number;
  errors: number;
  /** Seconds left while the scan waits for the photo analysis limit to reset. */
  waitingSeconds?: number;
}

export interface HistoryScanResult extends HistoryProgress {
  status: "imported" | "permission_denied" | "unavailable" | "cancelled" | "empty";
  capped: boolean;
  message: string;
}
