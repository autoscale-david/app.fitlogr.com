export interface Env {
  DB?: D1Database;
  ASSETS?: Fetcher;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  OPENROUTER_API_KEY?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
  GOOGLE_CLOUD_PROJECT_ID?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  GOOGLE_PHOTOS_ALBUM_NAME?: string;
  OPENROUTER_BASE_URL?: string;
  OPENROUTER_VISION_MODEL?: string;
  OPENROUTER_VISION_FALLBACK_MODELS?: string;
  OPENROUTER_TEXT_MODEL?: string;
  OPENROUTER_TEXT_FALLBACK_MODELS?: string;
  APP_URL?: string;
  API_BASE_URL?: string;
  ENVIRONMENT?: string;
  /** Override the rolling vision caps. Absent uses the defaults (40 per 5 minutes, 400 per day). */
  VISION_BURST_LIMIT?: string;
  VISION_DAILY_LIMIT?: string;
}
