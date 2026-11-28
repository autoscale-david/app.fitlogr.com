PRAGMA foreign_keys = ON;

-- 1. User identities and profiles
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  apple_sub TEXT UNIQUE,                       -- Reserved only if App Store requires Sign in with Apple
  email TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. Preferences and fitness goals
CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  unit_system TEXT NOT NULL DEFAULT 'imperial' CHECK (unit_system IN ('metric', 'imperial')),
  target_weight_kg REAL,
  daily_calorie_target_kcal INTEGER,
  daily_calorie_delta_target_kcal INTEGER,     -- e.g., -500 for deficit, 0 for maintain
  daily_protein_target_g INTEGER,
  daily_carbs_target_g INTEGER,
  daily_fat_target_g INTEGER,
  auto_scan_photos INTEGER NOT NULL DEFAULT 1,
  wifi_only_uploads INTEGER NOT NULL DEFAULT 0,
  confirm_before_ai INTEGER NOT NULL DEFAULT 0,
  photo_scan_since TEXT,                       -- Ignore camera roll older than this UTC timestamp
  ai_consent_version TEXT,
  ai_consent_accepted_at TEXT,
  updated_at TEXT NOT NULL
);

-- 3. Connected devices
CREATE TABLE user_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  device_name TEXT,
  app_version TEXT,
  os_version TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_user_devices_user ON user_devices(user_id);

-- 4. Encrypted OAuth credentials (NEVER store plaintext tokens)
CREATE TABLE user_oauth_tokens (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  encrypted_refresh_token TEXT NOT NULL,       -- Base64 AES-256-GCM ciphertext+tag
  refresh_token_iv TEXT NOT NULL,              -- Base64 unique 96-bit random IV
  encrypted_access_token TEXT,                 -- Optional short-lived cache, AES-256-GCM
  access_token_iv TEXT,
  access_token_expires_at TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  scopes TEXT NOT NULL,                        -- Space-separated granted scopes
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  last_refreshed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- 5. Google Photos album metadata
CREATE TABLE user_google_photos (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  album_id TEXT NOT NULL,
  album_title TEXT NOT NULL,
  product_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'missing', 'quota_exceeded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 6. Photos: media item IDs, hashes, and processing status (NO photo binaries, NO temporary URLs)
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES user_devices(id) ON DELETE SET NULL,
  content_sha256 TEXT NOT NULL,
  perceptual_hash TEXT,                        -- 16-char hex 64-bit dHash for near-duplicate detection
  captured_at TEXT NOT NULL,
  local_date TEXT NOT NULL,                    -- YYYY-MM-DD
  timezone TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'device_library' CHECK (source IN ('device_library', 'google_picker', 'manual')),
  status TEXT NOT NULL CHECK (
    status IN ('analyzed_meal', 'analyzed_non_meal', 'excluded', 'duplicate', 'upload_failed', 'quota_exceeded')
  ),
  is_meal INTEGER NOT NULL DEFAULT 0,
  meal_confidence REAL,
  google_media_item_id TEXT,                   -- Persistent ID from Google Photos Library API
  google_album_id TEXT,
  google_status TEXT NOT NULL DEFAULT 'none' CHECK (
    google_status IN ('none', 'uploaded', 'missing', 'quota_exceeded', 'failed')
  ),
  duplicate_of_photo_id TEXT REFERENCES photos(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (user_id, content_sha256)
);
CREATE INDEX idx_photos_user_date ON photos(user_id, local_date);
CREATE INDEX idx_photos_user_updated ON photos(user_id, updated_at, id);
CREATE INDEX idx_photos_user_phash ON photos(user_id, perceptual_hash, captured_at);

-- 7. Meals: meal records and backend-computed nutritional totals
CREATE TABLE meals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id TEXT UNIQUE REFERENCES photos(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  meal_type TEXT NOT NULL DEFAULT 'meal' CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack', 'meal')),
  eaten_at TEXT NOT NULL,
  local_date TEXT NOT NULL,                    -- YYYY-MM-DD in user's local timezone
  timezone TEXT NOT NULL,
  calories_kcal REAL NOT NULL DEFAULT 0,
  protein_g REAL NOT NULL DEFAULT 0,
  carbs_g REAL NOT NULL DEFAULT 0,
  fat_g REAL NOT NULL DEFAULT 0,
  ai_confidence REAL,
  ai_notes TEXT,
  is_ai_estimate INTEGER NOT NULL DEFAULT 1,
  is_user_edited INTEGER NOT NULL DEFAULT 0,   -- Protects user edits from overwrite
  user_edited_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_meals_user_date ON meals(user_id, local_date, eaten_at);
CREATE INDEX idx_meals_user_updated ON meals(user_id, updated_at, id);

-- 8. Individual food items belonging to a meal
CREATE TABLE meal_items (
  id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'serving',
  estimated_grams REAL,
  calories_kcal REAL NOT NULL DEFAULT 0,
  protein_g REAL NOT NULL DEFAULT 0,
  carbs_g REAL NOT NULL DEFAULT 0,
  fat_g REAL NOT NULL DEFAULT 0,
  confidence REAL,
  is_user_edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_meal_items_meal ON meal_items(meal_id, sort_order);
CREATE INDEX idx_meal_items_user_updated ON meal_items(user_id, updated_at, id);

-- 9. Normalized health and fitness records (HealthKit & Health Connect)
CREATE TABLE health_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES user_devices(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('healthkit', 'health_connect', 'manual')),
  record_type TEXT NOT NULL CHECK (
    record_type IN ('weight', 'active_calories', 'resting_calories', 'workout', 'steps', 'heart_rate_summary', 'resting_heart_rate')
  ),
  source_record_id TEXT NOT NULL,              -- Deterministic dedupe key (platform UUID or bucket key)
  source_app_id TEXT,                          -- Bundle ID / Android package name
  source_device_name TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  local_date TEXT NOT NULL,                    -- YYYY-MM-DD
  timezone TEXT NOT NULL,
  value_num REAL NOT NULL,                     -- Primary numeric value (kg, kcal, steps, bpm, duration_sec)
  unit TEXT NOT NULL,                          -- 'kg', 'kcal', 'count', 'bpm', 'sec'
  metadata_json TEXT,                          -- Workout details (activity_type, workout_kcal, distance_m, avg_hr) or HR min/max
  is_user_edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (user_id, platform, record_type, source_record_id)
);
CREATE INDEX idx_health_user_date_type ON health_records(user_id, local_date, record_type);
CREATE INDEX idx_health_user_updated ON health_records(user_id, updated_at, id);

-- 10. Pre-aggregated daily statistics & cached AI insight
CREATE TABLE daily_summaries (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,                    -- YYYY-MM-DD
  timezone TEXT NOT NULL,
  calories_in_kcal REAL NOT NULL DEFAULT 0,
  protein_g REAL NOT NULL DEFAULT 0,
  carbs_g REAL NOT NULL DEFAULT 0,
  fat_g REAL NOT NULL DEFAULT 0,
  meal_count INTEGER NOT NULL DEFAULT 0,
  active_calories_kcal REAL NOT NULL DEFAULT 0,
  resting_calories_kcal REAL NOT NULL DEFAULT 0,
  total_calories_out_kcal REAL NOT NULL DEFAULT 0,
  calorie_balance_kcal REAL NOT NULL DEFAULT 0,-- calories_in - total_calories_out
  steps INTEGER NOT NULL DEFAULT 0,
  workout_count INTEGER NOT NULL DEFAULT 0,
  workout_minutes INTEGER NOT NULL DEFAULT 0,
  weight_kg REAL,                              -- Latest weight on or before this date (or day's weight)
  resting_heart_rate_bpm REAL,
  avg_heart_rate_bpm REAL,
  ai_insight TEXT,
  insight_input_hash TEXT,                     -- SHA-256 of summary+goals inputs; avoids duplicate AI calls
  insight_generated_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, local_date)
);
CREATE INDEX idx_daily_summaries_user_updated ON daily_summaries(user_id, updated_at, local_date);

-- 11. Per-device, per-source synchronization checkpoints
CREATE TABLE sync_checkpoints (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                        -- e.g., 'healthkit:weight', 'health_connect:changes', 'media_library', 'delta_pull'
  cursor_value TEXT,                           -- Opaque anchor/token/timestamp
  last_synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, source)
);

-- 12. AI usage, latency, and cost tracking
CREATE TABLE ai_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL CHECK (request_type IN ('meal_vision', 'daily_insight')),
  model TEXT NOT NULL,
  fallback_used INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  estimated_cost_usd REAL,
  latency_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'schema_error', 'upstream_error', 'rate_limited')),
  related_entity_id TEXT,                      -- photo_id or local_date
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_requests_user_created ON ai_requests(user_id, created_at);
CREATE INDEX idx_ai_requests_created ON ai_requests(created_at);

-- Support table A: Application refresh sessions (revocation & multi-device management)
CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES user_devices(id) ON DELETE SET NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,     -- SHA-256 of opaque refresh token
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id, revoked_at);

-- Support table B: Short-lived OAuth PKCE state & 60s app exchange codes
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,                 -- SHA-256 of state or exchange_code
  kind TEXT NOT NULL CHECK (kind IN ('oauth_start', 'app_exchange')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,                  -- { pkce_verifier, nonce, redirect_uri, client_challenge } or { user_id, client_challenge }
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_oauth_states_expires ON oauth_states(expires_at);
