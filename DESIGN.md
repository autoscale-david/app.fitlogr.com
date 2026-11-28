# fitlogr System Design

**Status:** Proposed for review and approval  
**Repository:** `app.fitlogr.com`  
**Website & API:** `https://fitlogr.com` / `https://fitlogr.com/api`  
**Principles:** 100% free, friction-free, AI-first, cross-platform, privacy-first, cost-efficient

This document defines the technical architecture, data model, API contracts, mobile design, security controls, testing/deployment pipeline, and phased implementation plan for **fitlogr**. Every choice aligns strictly with `README.md` and optimizes for simplicity, maintainability, and near-zero marginal operating cost.

---

## 1. System Architecture and Technology Stack

### 1.1 High-Level Architecture

fitlogr uses a deliberately lean **two-tier architecture** (one cross-platform mobile client + one Cloudflare Worker backed by Cloudflare D1). The iPhone app keeps meal photos on the phone and sends AI inference to OpenRouter. Google Photos album upload remains only for older app builds that omit `upload_to_google_photos: false`.

```text
+-----------------------------------------------------------------------+
|                fitlogr Mobile App (iOS & Android)                     |
|         React Native + Expo + TypeScript + Expo Router                |
|                                                                       |
|  +------------------+  +------------------+  +---------------------+  |
|  | Expo MediaLibrary|  | HealthKit (iOS)  |  | Expo SQLite (Cache  |  |
|  | Local Photo Scan |  | Health Connect   |  | + Offline Outbox)   |  |
|  | + Dedupe + Filter|  | (Android)        |  | Expo SecureStore    |  |
|  +--------+---------+  +--------+---------+  +----------+----------+  |
+-----------|---------------------|------------------------|------------+
            |                     |                        |
            +---------------------+------------------------+
                                  | HTTPS (JSON + compressed JPEG uploads)
                                  v
+-----------------------------------------------------------------------+
|             Cloudflare Worker (https://fitlogr.com)                   |
|                  TypeScript + Hono + Zod                              |
|                                                                       |
|   Static Site (Workers Static Assets: /, /privacy, /terms)            |
|   REST API (/api/*): Auth, Photos, Meals, Health, Sync, Insights      |
|   In-memory image pass-through only (zero disk/bucket photo storage)  |
+-----------+-------------------------+---------------------+-----------+
            |                         |                     |
            v                         v                     v
+-------------------+     +-----------------------+   +------------------+
|  Cloudflare D1    |     |  Google Cloud         |   |   OpenRouter     |
|  (SQLite Edge DB) |     |  (`fitlogr-app`)      |   |  (Backend-only)  |
|                   |     |  - OAuth 2.0 / OIDC   |   |  - Vision meal   |
|  Authoritative    |     |  - Photos Library API |   |    analysis      |
|  structured data, |     |    (`fitlogr` album)  |   |  - Text daily    |
|  encrypted tokens,|     |  - Photos Picker API  |   |    insights      |
|  media item IDs   |     |    (optional import)  |   |                  |
+-------------------+     +-----------------------+   +------------------+
```

### 1.2 Architectural Invariants

1. **Authoritative Data Boundaries:**
   - **Cloudflare D1** is authoritative for user accounts, settings, goals, meal records, food items, normalized health records, daily summaries, sync checkpoints, and Google Photos media item IDs.
   - **The phone** is where meal photo files live. The iPhone app shows the local file or the Apple Photos asset, and falls back to a Google Photos URL only for meals an older build already uploaded.
   - **Expo SQLite** on the phone is a full offline read cache and mutation outbox, synced incrementally with D1.
2. **Zero Permanent Photo Storage on fitlogr Infrastructure:** Image bytes exist only in Cloudflare Worker request memory during analysis, then are discarded. The new iPhone app does not upload them. Neither D1 nor Cloudflare R2/KV stores photo binaries.
3. **Backend-Only Secrets and Third-Party Calls:** The mobile app never receives `OPENROUTER_API_KEY`, `GOOGLE_OAUTH_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET`, or Google OAuth access/refresh tokens. All OpenRouter and Google Photos Library API calls execute from the Worker.
4. **Minimal Infrastructure Footprint:** No separate database host, container cluster, message queue, Redis, KV, Durable Objects, or R2 bucket is required for v1. Cloudflare Workers + D1 + mobile SQLite handle all workloads cleanly within Cloudflare's low-cost tiers.

### 1.3 Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| Monorepo | npm workspaces (`mobile/`, `worker/`, `shared/`) | Zero extra build orchestrator needed; native Node/npm support on Windows and Linux CI |
| Shared contracts | TypeScript + Zod (`shared/`) | Single source of truth for API schemas, nutrition math, date/timezone helpers, and error codes |
| Mobile app | React Native, Expo (SDK 52+), TypeScript, Expo Router | Single iOS/Android codebase, file-based routing, Windows-friendly dev workflow |
| Mobile local data | `expo-sqlite`, `expo-secure-store`, `expo-file-system` | Offline-first SQLite cache/outbox, hardware-backed Keychain/Keystore token storage, clearable thumbnail cache |
| Mobile media | `expo-media-library`, `expo-image-manipulator`, `expo-crypto` | Incremental camera roll discovery, on-device resize/JPEG compression/EXIF strip, SHA-256 hashing |
| On-device pre-filter | Heuristics (all builds) + optional TFLite binary food classifier (EAS builds) | Filters non-food photos locally before network upload while keeping Expo Go functional |
| Mobile health | `@kingstinct/react-native-healthkit` (iOS), `react-native-health-connect` (Android) | Direct native bridges with Expo config plugins, abstracted behind a mockable `HealthProvider` |
| Mobile builds & delivery | Expo EAS Build (`development`, `preview`, `production`), TestFlight / App Store, Google Play | Cloud iOS builds from Windows without a local Mac |
| Website & API | Cloudflare Workers (TypeScript, Hono router, Workers Static Assets) | Single deployment serving `https://fitlogr.com` and `https://fitlogr.com/api/*` |
| Database | Cloudflare D1 with Wrangler SQL migrations | Serverless SQLite with strict SQL constraints, transactional batches, and minimal cost |
| Photo storage | Google Photos Library API (+ optional Google Photos Picker API) | Keeps meal images in user-owned storage; $0 media hosting cost for fitlogr |
| AI inference | OpenRouter (`https://openrouter.ai/api/v1`) | Model-agnostic multimodal & text API; instant backend model switching and fallbacks |
| CI/CD | GitHub Actions + Cloudflare Wrangler | Automated checks, D1 migrations, Worker deployment, and smoke verification |

### 1.4 Monorepo Layout

```text
app.fitlogr.com/
├── mobile/                     # React Native / Expo app
│   ├── app/                    # Expo Router screens and layouts
│   ├── components/             # Reusable UI components
│   ├── services/               # API client, SQLite store, sync engine, photo scanner, health adapters
│   ├── hooks/                  # Data, sync, auth, and permission hooks
│   ├── assets/                 # App icons, splash, optional quantized food-filter model
│   ├── app.config.ts           # Dynamic Expo config (plugins, schemes, HealthKit/HC entitlements)
│   ├── eas.json                # EAS build profiles (development, preview, production)
│   └── package.json
├── worker/                     # Cloudflare Worker (website + REST API)
│   ├── src/
│   │   ├── index.ts            # Worker entrypoint, middleware, error handling
│   │   ├── env.ts              # Typed Cloudflare Env bindings & secret interface
│   │   ├── routes/             # auth, settings, photos, meals, health, daily, sync, account
│   │   ├── services/           # google-oauth, google-photos, openrouter, nutrition, sync, crypto
│   │   └── db/                 # Parameterized D1 query modules (user-scoped)
│   ├── public/                 # Static marketing site, /privacy, /terms, /support
│   ├── migrations/             # Ordered D1 SQL migrations (0001_initial.sql, ...)
│   ├── wrangler.toml           # Worker routes, D1 binding, Workers Static Assets, non-secret vars
│   └── package.json
├── shared/                     # Shared TypeScript package (@fitlogr/shared)
│   ├── src/
│   │   ├── schemas/            # Zod request/response & AI output schemas
│   │   ├── nutrition/          # Calorie/macro total & balance calculation utilities
│   │   ├── health/             # Normalized health record types & double-count rules
│   │   ├── errors.ts           # Canonical API error codes
│   │   └── index.ts
│   └── package.json
├── docs/                       # Additional project & compliance documentation
├── .github/workflows/          # ci.yml, deploy-worker.yml
├── .env.example                # Documented environment variable template (no secret values)
├── .gitignore
├── package.json                # Workspace root scripts
├── DESIGN.md                   # This document
└── README.md
```

### 1.5 Configuration & Secrets Alignment

Exact secret and configuration names from `README.md` are preserved verbatim:

| Name | Location | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub Actions Secret | Deploy Worker & apply D1 migrations |
| `GOOGLE_OAUTH_CLIENT_ID` | Worker Secret | Centralized Google Web OAuth client ID (`fitlogr-app`) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Worker Secret | Centralized Google Web OAuth client secret |
| `OPENROUTER_API_KEY` | Worker Secret | OpenRouter API authentication (Worker only) |
| `TOKEN_ENCRYPTION_KEY` | Worker Secret | Base64-encoded 256-bit key for AES-256-GCM OAuth token encryption |
| `SESSION_SECRET` | Worker Secret | HMAC-SHA256 signing key for fitlogr application session JWTs |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler.toml` / `.env.example` | `42aad73fe98811972eccd8907196d722` |
| `CLOUDFLARE_ZONE_ID` | `wrangler.toml` / `.env.example` | `4da8c98a66722b963535773610a7d0d8` |
| `GOOGLE_CLOUD_PROJECT_ID` | `wrangler.toml` / `.env.example` | `fitlogr-app` |
| `GOOGLE_OAUTH_REDIRECT_URI` | `wrangler.toml` / `.env.example` | `https://fitlogr.com/api/auth/google/callback` |
| `GOOGLE_PHOTOS_ALBUM_NAME` | `wrangler.toml` / `.env.example` | `fitlogr` |
| `OPENROUTER_BASE_URL` | `wrangler.toml` / `.env.example` | `https://openrouter.ai/api/v1` |
| `OPENROUTER_VISION_MODEL` | `wrangler.toml` / Worker vars | Active multimodal model ID (hot-swappable without mobile release) |
| `OPENROUTER_TEXT_MODEL` | `wrangler.toml` / Worker vars | Active text model ID for daily insights |
| `APP_URL` | `wrangler.toml` / `.env.example` | `https://fitlogr.com` |
| `API_BASE_URL` | `wrangler.toml` / `.env.example` | `https://fitlogr.com/api` |

Optional non-secret tuning vars in `wrangler.toml`: `OPENROUTER_VISION_FALLBACK_MODELS` (comma-separated fallback model IDs), `OPENROUTER_TEXT_FALLBACK_MODELS`, `TOKEN_ENCRYPTION_KEY_VERSION` (default `"1"`), and `ENVIRONMENT` (`"development" | "staging" | "production"`).

### 1.6 Operating Cost Profile (Why This Stays Free)

- **Cloudflare Workers & D1:** Workers Free / Paid ($5/mo base for 10M requests/mo) and D1 Free (5M reads/day, 100k writes/day, 5 GB storage) cover thousands of daily active users before incremental usage charges apply.
- **Photo Storage:** $0/month on fitlogr infrastructure (stored in user's Google Photos).
- **OpenRouter Inference:** With compressed `<=1280px` JPEG inputs (~800–1,200 vision tokens) and a cost-efficient multimodal model (e.g., Gemini Flash-Lite / GPT-4o-mini class), analyzing 3–4 meals/day plus 1 cached daily insight costs roughly **$0.002–$0.005 per active user/day** (~$0.06–$0.15/active user/month), bounded further by on-device pre-filtering, hash deduplication, and per-user rate limits.

---

## 2. Mobile App Structure and User Experience

### 2.1 UX Philosophy: The 30-Second Evening Review

Users must not need to open fitlogr after every meal or workout. The app operates around two quiet loops and one fast review screen:

1. **Silent/automatic capture loop:** User takes meal photos with their stock camera app and wears their fitness watch throughout the day.
2. **Foreground + best-effort background sync:** Whenever fitlogr opens (and opportunistically in the background where OS budgets allow), it discovers new camera photos since the last checkpoint, pre-filters and deduplicates them, submits meal candidates for AI analysis, and pulls incremental HealthKit / Health Connect changes.
3. **Evening review:** Opening the app lands directly on **Today**, showing calorie balance, macros, meal photos with estimates, workouts, weight, and one short AI daily insight. Tapping any meal allows 2-tap correction or exclusion.

### 2.2 Navigation Structure (Expo Router)

```text
mobile/app/
├── _layout.tsx                 # Root provider: SQLite init, Auth gate, Sync provider, Theme
├── (auth)/
│   ├── welcome.tsx             # Value prop + "Continue with Google" CTA
│   ├── consent.tsx             # Explicit AI & photo processing + Google Photos backup disclosure
│   ├── permissions.tsx         # Step-by-step Photo Library + HealthKit/Health Connect requests
│   └── goals.tsx               # Quick initial targets (weight goal, daily calories, macro split)
├── (tabs)/
│   ├── _layout.tsx             # Bottom tabs: Today | Meals | Trends | Settings
│   ├── index.tsx               # Today (Evening Review Dashboard)
│   ├── meals.tsx               # Chronological Meal Feed, pending queue, excluded items, Picker import
│   ├── trends.tsx              # 7d/30d/90d weight, calorie balance, and macro trends
│   └── settings.tsx            # Account, Google Photos status, Health sync, Goals, Photo prefs, Export/Delete
└── modal/
    ├── meal/[id].tsx           # Full meal photo, AI estimate badge, item-level editor, Exclude/Delete
    ├── meal/new.tsx            # Manual quick-add meal fallback (no photo required)
    └── picker-import.tsx       # Optional Google Photos Picker historical import flow
```

### 2.3 Key Screen Specifications

- **Onboarding (`(auth)/*`):**
  - Clear, plain-language consent before any photo is read or uploaded: explains that candidate meal photos are compressed, sent to fitlogr's backend and OpenRouter for nutritional estimation, and saved to the user's own `fitlogr` Google Photos album (noting that standard Google Photos device backup may keep a separate copy in their main library).
  - Permissions are requested progressively with clear rationale; if a user declines Health or Photo permissions, the app degrades gracefully with inline banners and one-tap deep links to OS settings.
  - Records `ai_consent_accepted_at` and `ai_consent_version` in `user_settings` before enabling cloud photo analysis.
- **Today Dashboard (`(tabs)/index.tsx`):**
  - **Date Bar:** Today by default, swipe/tap arrows to inspect any historical date using the user's local timezone.
  - **Calorie Balance Card:** Visual summary of `Intake` vs. `Burned` (`Active + Resting`) and `Deficit / Surplus`, compared against the user's daily calorie goal.
  - **Macros Row:** Protein, Carbs, and Fat grams + target progress bars.
  - **AI Daily Insight Card:** 2–3 concise sentences synthesizing today's intake, expenditure, protein/macro balance, and recent weight trend. Never blocks screen rendering (loads asynchronously; cached locally).
  - **Meals Strip / List:** Meal cards ordered by capture time (`Breakfast`, `Lunch`, `Dinner`, `Snack` inferred from time/context) with photo thumbnail, meal name, calories, macro summary, and subtle `"AI estimate"` or `"Edited"` indicator. Shows subtle inline status for photos currently analyzing or awaiting retry.
  - **Activity & Body Card:** Today's weight (or most recent weight with date), workouts list (type, duration, workout calories), steps, and resting/average heart rate.
  - **Pull-to-Refresh:** Triggers immediate incremental photo scan + health sync + server delta pull + insight refresh so evening review works even if OS background sync never ran.
- **Meal Detail & Correction (`modal/meal/[id].tsx`):**
  - Displays meal photo (from local thumbnail/full cache or freshly fetched Google Photos `baseUrl`), capture timestamp, and clear `"AI nutritional estimate — tap any item to adjust"` banner.
  - Inline editing of meal name, capture time, item names, portion quantities/grams, calories, protein, carbs, and fat. Adding/removing food items recomputes totals immediately on-device and authoritatively on the Worker.
  - One-tap **"Not a meal / Exclude photo"** button: removes the meal from daily totals, marks the photo `excluded` (preventing re-discovery), and optionally leaves or informs the user about the Google Photos copy.
- **Settings (`(tabs)/settings.tsx`):**
  - Account status (Google email, `fitlogr` album link/status, one-tap **Reconnect Google** if token revoked).
  - Health integration status (Apple Health / Health Connect connected types, last sync time, `"Sync Now"` button).
  - Photo discovery preferences: Auto-scan on app open (on/off), Wi-Fi-only photo upload (on/off), `"Confirm before analyzing"` mode (optional manual gate vs. default automatic analysis), ignore screenshots (on by default), tracking start date.
  - Goals & Units: metric (`kg`, `g`) vs. imperial (`lb`, `oz`), target weight, daily calorie target or target deficit/surplus, macro targets.
  - Data & Privacy: **Export My Data** (downloads JSON archive via system share sheet), **Delete Account** (double-confirmation dialog explicitly stating that fitlogr records are permanently deleted while Google Photos albums/photos remain untouched).

### 2.4 Windows Development Workflow (No Local Mac Required)

Per `README.md`, development must work smoothly on Windows in Cursor without a local Mac while supporting Fast Refresh and physical iOS/Android testing:

| Capability | Expo Go (Windows LAN/Tunnel) | EAS Development Build (`eas build --profile development`) |
|---|---|---|
| Expo Router UI, navigation, theming | Full support + Fast Refresh | Full support + Fast Refresh |
| `expo-sqlite` & `expo-secure-store` | Full support | Full support |
| `expo-media-library` & `expo-image-manipulator` | Full support | Full support |
| Google OAuth via `expo-web-browser` | Supported via `exp://` redirect (dev-only allowlist) | Full support via `fitlogr://auth/callback` |
| Apple HealthKit (iOS) | Mock adapter (`MockHealthProvider`) | Native `@kingstinct/react-native-healthkit` |
| Android Health Connect | Mock adapter (`MockHealthProvider`) | Native `react-native-health-connect` |
| On-device TFLite food classifier | Skipped gracefully (heuristics / manual confirm) | Native TFLite inference |
| Background fetch / Health observers | Mock / foreground trigger | Native OS background tasks |

**Developer Loop on Windows:**
1. Run `npm run dev:worker` (Wrangler local D1) and `npm run dev:mobile` (Expo Metro) on Windows.
2. For UI, API, SQLite, auth, and photo-upload iteration, scan QR code in **Expo Go** or an already-installed **EAS Development Client** on physical iPhone/Android (both support instant Fast Refresh).
3. Rebuild the EAS Development Client in the cloud (`eas build --profile development --platform ios|android`) **only** when native dependencies, Expo config plugins, or entitlements change (rare after Phase 5 setup). Distribute iOS dev builds via Apple ad-hoc provisioning or TestFlight internal testing — zero local macOS hardware required.

---

## 3. Backend Architecture and API Endpoints

### 3.1 Worker Structure & Middleware Pipeline

A single Cloudflare Worker (`worker/src/index.ts`) serves both the static website (`https://fitlogr.com/*` via Workers Static Assets in `worker/public/`) and all API routes (`https://fitlogr.com/api/*`) using **Hono**.

Middleware order for `/api/*`:
1. **Request ID & Structured Logging:** Attaches `X-Request-Id`; logs method, path, status, latency, and user ID hash only (never request bodies, headers, tokens, or PII).
2. **Security Headers & CORS:** Strict CSP/HSTS/X-Content-Type-Options; CORS restricted to `https://fitlogr.com` (mobile native requests are non-CORS).
3. **Body Size Guard:** Rejects JSON requests `> 1 MB` and photo analysis multipart payloads `> 3 MB` (`413 PAYLOAD_TOO_LARGE`).
4. **Authentication Middleware (private routes):** Verifies HMAC-SHA256 JWT (`Authorization: Bearer <token>`) signed with `SESSION_SECRET`, checks expiration, and injects `c.var.auth = { userId, deviceId, sessionId }`.
5. **Rate Limiting Middleware:** Lightweight D1-backed / isolate-cached sliding window per user and per IP (for auth routes), preventing OpenRouter spend spikes without requiring Redis or paid add-ons.
6. **Zod Request Validation:** Shared schemas from `@fitlogr/shared` validate params, query, and JSON bodies.
7. **Unified Error Handler:** Returns deterministic JSON errors:

```json
{
  "error": {
    "code": "GOOGLE_AUTH_REVOKED",
    "message": "Google Photos access was revoked. Please reconnect your Google account.",
    "request_id": "req_01J..."
  }
}
```

### 3.2 Canonical Error Codes

- `VALIDATION_ERROR` (400), `UNSUPPORTED_MEDIA_TYPE` (415), `PAYLOAD_TOO_LARGE` (413)
- `AUTH_REQUIRED` (401), `AUTH_EXPIRED` (401), `AUTH_INVALID` (401)
- `GOOGLE_AUTH_REVOKED` (403), `GOOGLE_QUOTA_EXCEEDED` (403), `AI_CONSENT_REQUIRED` (403)
- `NOT_FOUND` (404), `CONFLICT` (409)
- `RATE_LIMITED` (429, includes `Retry-After` header)
- `AI_UPSTREAM_ERROR` (502), `GOOGLE_UPSTREAM_ERROR` (502), `INTERNAL_ERROR` (500)

### 3.3 REST API Endpoints

All endpoints live under `https://fitlogr.com/api`. Additive backward compatibility is enforced (optional fields only; breaking changes require a new path prefix) to protect released mobile builds.

#### Public & Auth

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | Public | Liveness & D1 connectivity check (`{ ok, version, db_ok }`) |
| `POST` | `/api/auth/google/start` | Public or Bearer (reconnect/scope upgrade) | Validates allowlisted app `redirect_uri`, stores PKCE/state/nonce in D1, returns `{ authorize_url }` |
| `GET` | `/api/auth/google/callback` | Public (Google redirect) | Validates `state`, exchanges code with Google, verifies ID token, encrypts & stores refresh token, issues 60s single-use `exchange_code`, redirects `302` to app redirect URI |
| `POST` | `/api/auth/exchange` | Public (PKCE verifier) | Exchanges `exchange_code` + `client_verifier` + device metadata for `{ access_token, refresh_token, expires_at, user }` |
| `POST` | `/api/auth/refresh` | Public (refresh token) | Rotates `refresh_token`, revokes previous token (detects reuse), returns fresh `{ access_token, refresh_token, expires_at }` |
| `POST` | `/api/auth/logout` | Bearer | Revokes current session (or all sessions if `?all=true`) |
| `GET` | `/api/me` | Bearer | Returns user profile, settings summary, Google Photos connection status, and connected devices |

#### Settings & Goals

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/settings` | Bearer | Returns `user_settings` (goals, units, timezone, photo prefs, AI consent status) |
| `PUT` | `/api/settings` | Bearer | Updates settings/goals with optimistic `updated_at` check; updates `ai_consent_accepted_at` when consented |

#### Photos, Meal Recognition & Google Photos

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/photos/check-hashes` | Bearer | Accepts up to 100 `{ content_sha256, perceptual_hash, captured_at }` items; returns which hashes already exist or match near-duplicates in D1 **before** mobile uploads any image bytes |
| `POST` | `/api/photos/analyze` | Bearer | Multipart form (`image` compressed JPEG `<= 2 MB` + `metadata` JSON: `client_photo_id`, `content_sha256`, `perceptual_hash`, `captured_at`, `local_date`, `timezone`, `device_id`, `force_meal?`). Deduplicates -> calls OpenRouter vision -> computes totals -> if meal, uploads to user's Google Photos `fitlogr` album -> writes `photos`, `meals`, `meal_items`, `daily_summaries`, `ai_requests` -> returns full result |
| `POST` | `/api/photos/urls` | Bearer | Accepts `{ photo_ids: string[] }` (max 50); calls Google Photos `mediaItems:batchGet` for the user's `google_media_item_id`s; returns `{ urls: { [photo_id]: { url, expires_at, status } } }` |
| `POST` | `/api/photos/:photoId/exclude` | Bearer | Marks photo `status = 'excluded'`, soft-deletes associated meal, and recomputes `daily_summaries` for that date |
| `POST` | `/api/photos/picker/sessions` | Bearer | Optional historical import: verifies `photospicker.mediaitems.readonly` scope (or returns scope-upgrade prompt), creates a Google Photos Picker session, returns `{ session_id, picker_uri }` |
| `POST` | `/api/photos/picker/sessions/:sessionId/import` | Bearer | Polls Picker session items, streams selected photo bytes in-memory through the same dedupe + OpenRouter + `fitlogr` album pipeline (bounded batch size, e.g. max 10 photos/request to stay well within Worker CPU/timeout budgets) |

#### Meals

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/meals?from=YYYY-MM-DD&to=YYYY-MM-DD` | Bearer | Lists meals and their `meal_items` + `photo` metadata for a local date range |
| `GET` | `/api/meals/:mealId` | Bearer | Fetches single meal with items and photo metadata |
| `POST` | `/api/meals` | Bearer | Manual meal creation fallback (no photo required); backend computes totals & refreshes `daily_summaries` |
| `PATCH` | `/api/meals/:mealId` | Bearer | Applies user corrections to meal name, timestamp, meal type, or `meal_items[]`; sets `is_user_edited = 1`; recomputes totals on backend and refreshes `daily_summaries` |
| `DELETE` | `/api/meals/:mealId` | Bearer | Soft-deletes meal (`deleted_at`), marks linked photo `excluded` if requested, refreshes `daily_summaries` |

#### Health Data, Dashboard, Insights & Sync

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/health/sync` | Bearer | Idempotent batch upsert (up to 250 records/request) of normalized `health_records` + updated `sync_checkpoints`; recomputes affected `daily_summaries` dates |
| `GET` | `/api/health/records?from=YYYY-MM-DD&to=YYYY-MM-DD&type=...` | Bearer | Queries normalized health records for trends/charts |
| `GET` | `/api/daily?from=YYYY-MM-DD&to=YYYY-MM-DD` | Bearer | Returns `daily_summaries` (intake, active/resting/total burn, balance, macros, weight, steps, workouts count, cached AI insight) |
| `POST` | `/api/daily/:date/insight` | Bearer | Generates or returns cached concise AI daily insight for `YYYY-MM-DD`; skips OpenRouter if `insight_input_hash` is unchanged |
| `GET` | `/api/sync/changes?since=<ISO_OR_SEQ>&limit=200` | Bearer | Incremental cross-device delta pull across `user_settings`, `photos`, `meals`, `meal_items`, `health_records`, `daily_summaries` (including `deleted_at` tombstones) |

#### Account Export & Deletion

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/account/export` | Bearer | Returns complete structured JSON export of profile, settings, meals, meal items, photo metadata/media IDs, health records, and daily summaries (`Content-Disposition: attachment`) |
| `DELETE` | `/api/account` | Bearer | Requires confirmation header/body; revokes Google OAuth token (best-effort), deletes user row in D1 (cascading all user data); explicitly **does not** delete Google Photos album or photos |

---

## 4. Database Schema and Data Synchronization

### 4.1 Cloudflare D1 Schema (`worker/migrations/0001_initial.sql`)

All 12 core tables specified in `README.md` are implemented, plus 2 minimal operational auth tables (`user_sessions`, `oauth_states`) so the Worker stays 100% stateless without requiring KV or Redis. Every user-owned table carries `user_id` with `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE` and composite `user_id`-leading indexes.

**Conventions:**
- IDs: Text UUIDv7 (time-ordered, globally unique across devices, safe for offline client generation on meals/photos).
- Timestamps: ISO-8601 UTC strings (`YYYY-MM-DDTHH:MM:SS.sssZ`).
- Local dates: `YYYY-MM-DD` in user's local timezone at capture/recording time.
- Sync ordering: `updated_at` UTC timestamps (plus monotonic `sync_seq` or `(updated_at, id)` cursor) so delta sync never misses rows updated within the same millisecond.

```sql
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
```

### 4.2 Mobile Local SQLite & Offline Outbox

The mobile app maintains an `expo-sqlite` database (`fitlogr_local.db`) containing:
- **Synced mirror tables:** `user_settings`, `photos`, `meals`, `meal_items`, `health_records`, `daily_summaries` (same logical columns as D1, cleared automatically on sign-out or account switch).
- **Local-only tables:**
  - `local_media_assets (local_asset_id PRIMARY KEY, uri, captured_at, content_sha256, perceptual_hash, local_food_score, scan_status, remote_photo_id, error_message, retry_count, updated_at)` — tracks every examined camera roll photo so it is never re-hashed or re-analyzed.
  - `sync_outbox (id PRIMARY KEY, entity_type, entity_id, method, path, payload_json, binary_file_uri, retry_count, next_retry_at, created_at)` — queues offline meal edits, exclusions, settings changes, health sync batches, and pending photo analyses with exponential backoff (`5s -> 30s -> 2m -> 15m`, capped at 1h).
  - `photo_url_cache (photo_id PRIMARY KEY, local_thumb_path, remote_url, remote_url_expires_at, updated_at)` — caches resized meal thumbnails in `FileSystem.cacheDirectory` for instant offline rendering.

### 4.3 Cross-Device Synchronization Protocol

1. **Push First (Outbox Drain):** When connectivity is available (app launch, foreground resume, pull-to-refresh, or network reconnect), drain `sync_outbox` FIFO using idempotent endpoints (`content_sha256` for photos, `(platform, record_type, source_record_id)` for health, meal/item UUIDs for edits).
2. **Pull Deltas:** Call `GET /api/sync/changes?since=<last_cursor>&limit=200` in a loop until `has_more === false`. Apply upserts and `deleted_at` tombstones inside a single local SQLite transaction per page, then advance `sync_checkpoints('delta_pull')`.
3. **Conflict & Edit Preservation Rules:**
   - **Meals & Meal Items:** Once `is_user_edited = 1`, no automated photo re-scan or AI retry may overwrite the meal. Multi-device manual edits resolve by latest `user_edited_at`.
   - **Excluded Photos:** `status = 'excluded'` is sticky across devices; another device seeing the same `content_sha256` or near-duplicate `perceptual_hash` skips it immediately via `/api/photos/check-hashes`.
   - **Health Records:** Deduplicated by `UNIQUE(user_id, platform, record_type, source_record_id)`; updated samples overwrite only if `is_user_edited = 0`.
   - **Daily Summaries:** Always recomputed deterministically on the Worker inside the same D1 batch/transaction whenever meals, meal items, or health records for a `local_date` change, preventing client/server drift.

---

## 5. Google Authentication and Google Photos Integration

### 5.1 Centralized OAuth 2.0 / OIDC Flow

All iOS and Android installs authenticate through the single centralized Google Web OAuth client in Google Cloud project `fitlogr-app` (`https://fitlogr.com/api/auth/google/callback`).

```text
Mobile App                    Cloudflare Worker (fitlogr.com)               Google OAuth
    |                                       |                                     |
    |-- 1. POST /api/auth/google/start ---->|                                     |
    |   (redirect_uri, client_challenge)    |-- Store state, PKCE, nonce in D1    |
    |<-- { authorize_url } -----------------|                                     |
    |                                                                             |
    |-- 2. Open system browser (ASWebAuthenticationSession / Custom Tabs) ------->|
    |      User signs in & approves scopes                                        |
    |<-- 3. Redirect to https://fitlogr.com/api/auth/google/callback?code&state --|
    |                                       |                                     |
    |                                       |-- 4. Exchange code + PKCE verifier->|
    |                                       |<-- id_token, access_token, refresh -|
    |                                       |-- Verify ID token (JWKS, aud, nonce)|
    |                                       |-- AES-256-GCM encrypt refresh_token |
    |                                       |-- Upsert user & token in D1         |
    |                                       |-- Issue 60s single-use exchange_code|
    |<-- 5. 302 fitlogr://auth/callback?exchange_code=... ------------------------|
    |                                       |                                     |
    |-- 6. POST /api/auth/exchange -------->|                                     |
    |   (exchange_code, client_verifier)    |-- Verify client_verifier & consume  |
    |<-- { access_token, refresh_token } ---|   Issue fitlogr JWT + refresh token |
```

**Key Security Controls in Auth:**
- **Double PKCE / Handoff Protection:** Worker uses PKCE (`S256`) + `state` + `nonce` with Google, and the mobile app uses its own `client_verifier` / `client_challenge` (`S256`) to redeem the 60-second single-use `exchange_code`. Neither Google tokens nor fitlogr session tokens ever appear in a deep-link URL.
- **Redirect URI Allowlist:** Production only permits `fitlogr://auth/callback`. `exp://` schemes are permitted strictly when `ENVIRONMENT === 'development'`.
- **ID Token Verification:** Verified via Google's OIDC JWKS (`https://www.googleapis.com/oauth2/v3/certs`, cached in isolate memory honoring `Cache-Control`), validating signature, `iss`, `aud === GOOGLE_OAUTH_CLIENT_ID`, `exp`, and `nonce`. Identity keys off persistent `sub` (never mutable email).
- **Offline Access & Automatic Refresh:** Requests `access_type=offline&include_granted_scopes=true` (and `prompt=consent` on first login or when no active refresh token exists). Before any Google Photos API call, the Worker checks `access_token_expires_at` (with 120s safety margin) and transparently refreshes via Google's token endpoint using the decrypted refresh token.
- **Session Independence:** fitlogr access JWTs (1 hour TTL, HMAC-SHA256 via `SESSION_SECRET`) and rotating 90-day opaque refresh tokens (stored SHA-256 hashed in `user_sessions`) are decoupled from Google's access token lifecycle.
- **App Store Sign in with Apple Contingency:** `users.apple_sub` is reserved in schema. If Apple App Store Review requires Sign in with Apple (Guideline 4.8), Apple Sign-In can authenticate the fitlogr user first and then invoke `/api/auth/google/start` (with Bearer token) to link the required Google Photos account—no schema rewrite needed.

### 5.2 OAuth Scopes

- **Required at sign-in:**
  - `openid`
  - `email`
  - `profile`
  - `https://www.googleapis.com/auth/photoslibrary.appendonly`
  - `https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata`
- **Optional (incremental authorization only when user opens Historical Import):**
  - `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`

This design aligns with Google's March 2025 Google Photos API policy changes (which removed broad third-party read scopes and restricted Library API access to app-created albums/items while moving user-selected existing photo access to the Picker API).

### 5.3 Google Photos Album, Upload, Display & Failure Handling

1. **Dedicated `fitlogr` Album:** On the user's first confirmed meal upload (lazy creation), the Worker checks `user_google_photos`. If absent, it calls `POST https://photoslibrary.googleapis.com/v1/albums` with `{ album: { title: GOOGLE_PHOTOS_ALBUM_NAME } }` (`"fitlogr"`) and stores the persistent `album_id` in D1.
2. **Two-Step App-Managed Upload:**
   - Step A: `POST https://photoslibrary.googleapis.com/v1/uploads` with raw JPEG bytes, `Content-Type: application/octet-stream`, `X-Goog-Upload-Content-Type: image/jpeg`, `X-Goog-Upload-Protocol: raw` -> returns ephemeral `uploadToken`.
   - Step B: `POST https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate` with `albumId` and `newMediaItems: [{ description: "<meal name> — <calories> kcal (fitlogr)", simpleMediaItem: { uploadToken, fileName } }]` -> returns persistent `mediaItem.id`.
   - Persist `google_media_item_id` and `google_album_id` in `photos`. Never persist `baseUrl`.
3. **Fresh Image URL Retrieval:**
   - Mobile requests `POST /api/photos/urls` in batches of up to 50 `photo_id`s when displaying meals whose local thumbnail cache is missing or expired.
   - Worker calls `GET https://photoslibrary.googleapis.com/v1/mediaItems:batchGet?mediaItemIds=...`, appends sizing parameters (`=w360-h360-c` for feed thumbnails, `=w1080-h1080` for detail view), and returns URLs with a conservative 45-minute `expires_at` (Google `baseUrl`s expire after ~60 minutes).
4. **Resilient Edge-Case Handling:**
   - **Album deleted by user:** `batchCreate` returns `400`/`404` invalid album -> Worker creates a fresh `fitlogr` album, updates `user_google_photos`, and retries `batchCreate` once automatically.
   - **Photo deleted in Google Photos:** `batchGet` returns status `NOT_FOUND` -> Worker updates `photos.google_status = 'missing'`; mobile renders a clean placeholder while preserving all meal nutrition data.
   - **Revoked OAuth permissions:** Google returns `invalid_grant` or `401/403` insufficient scope -> Worker sets `user_oauth_tokens.status = 'revoked'`, returns `403 GOOGLE_AUTH_REVOKED`, and mobile shows a non-blocking reconnect banner while keeping local/D1 history readable.
   - **Google storage quota exhausted:** Upload fails with `RESOURCE_EXHAUSTED` / quota error -> Worker still saves the analyzed `meals` and `meal_items` in D1 so the user does not lose calorie tracking, sets `photos.google_status = 'quota_exceeded'`, and notifies the user in-app.
   - **Google Photos backup duplication notice:** Onboarding and Settings clearly inform users that standard Google Photos device backup is not required for fitlogr and, if enabled, may keep both the original camera backup and the `fitlogr` album copy.

---

## 6. AI-Powered Meal Recognition

### 6.1 End-to-End Photo Discovery & Analysis Pipeline

```text
1. Local Scan (Mobile)
   Expo MediaLibrary incremental scan since last checkpoint
   └─ Skip: non-images, screenshots, already-seen local_asset_id, older than photo_scan_since

2. Local Pre-Filter & Deduplication (Mobile)
   ├─ Compute SHA-256 content hash (`expo-crypto`) + 64-bit dHash (32x32 grayscale via `expo-image-manipulator` + tiny pure-TS decoder)
   ├─ Drop exact/near-duplicate burst shots locally (dHash Hamming <= 8 within +-15 min)
   └─ Run on-device binary food classifier (EAS builds, conservative recall threshold p >= 0.20)
      └─ Obvious non-food photos (documents, selfies, landscapes) are marked skipped locally & NEVER leave the phone

3. Pre-Upload Batch Dedupe Check (Mobile -> Worker)
   POST /api/photos/check-hashes (up to 100 candidates)
   └─ Worker checks D1 `photos` for exact `content_sha256` or near-duplicate `perceptual_hash` from another device

4. Compress & Analyze (Mobile -> Worker -> OpenRouter -> Google Photos)
   ├─ Mobile resizes candidate once to <=1280px longest edge, JPEG quality 0.80 (~120–280 KB), strips GPS/EXIF metadata
   ├─ POST /api/photos/analyze (multipart image + metadata)
   ├─ Worker checks user AI consent & daily rate limit
   ├─ Worker sends base64 data URI to OpenRouter (`OPENROUTER_VISION_MODEL`, structured JSON schema, `data_collection: "deny"`)
   ├─ Worker validates response with Zod & recalculates meal totals from `items[]`
   ├─ If `is_meal === false` (or confidence < 0.55): record `photos(status='analyzed_non_meal')`, discard bytes, DO NOT upload to Google Photos
   └─ If `is_meal === true`: upload exact JPEG bytes to Google Photos `fitlogr` album -> write `photos`, `meals`, `meal_items`, recompute `daily_summaries`, log `ai_requests` -> discard bytes
```

### 6.2 Structured OpenRouter Contract

All OpenRouter calls originate solely from `worker/src/services/openrouter.ts` to `${OPENROUTER_BASE_URL}/chat/completions` using `OPENROUTER_API_KEY`, passing `HTTP-Referer: https://fitlogr.com`, `X-Title: fitlogr`, and `provider: { data_collection: "deny" }` where supported so user photos are excluded from provider model training.

**Vision Response JSON Schema (`MealAnalysisSchema` in `shared/src/schemas/ai.ts`):**

```ts
export const MealAnalysisSchema = z.object({
  is_meal: z.boolean(),
  confidence: z.number().min(0).max(1),
  meal_name: z.string().min(1).max(120).nullable(),
  suggested_meal_type: z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'meal']).nullable(),
  notes: z.string().max(300).nullable(),
  items: z.array(z.object({
    name: z.string().min(1).max(100),
    quantity: z.number().positive().max(100),
    unit: z.string().min(1).max(30),
    estimated_grams: z.number().positive().max(5000).nullable(),
    calories_kcal: z.number().min(0).max(5000),
    protein_g: z.number().min(0).max(500),
    carbs_g: z.number().min(0).max(1000),
    fat_g: z.number().min(0).max(500),
    confidence: z.number().min(0).max(1),
  })).max(30),
});
```

**Backend Total Calculation & Guardrails:**
- The Worker **never** trusts LLM-summed totals. `shared/src/nutrition/totals.ts` computes:
  - `meal.calories_kcal = round1(sum(items.calories_kcal))`
  - `meal.protein_g = round1(sum(items.protein_g))`
  - `meal.carbs_g = round1(sum(items.carbs_g))`
  - `meal.fat_g = round1(sum(items.fat_g))`
- Sanity check: if an item's calories deviate wildly from Atwater energy (`4*P + 4*C + 9*F`, allowing alcohol/fiber margin), log a warning flag in `notes` without rejecting valid foods.
- If the primary model returns invalid JSON, times out (>20s), or returns 429/5xx, the Worker automatically retries once using the next configured model in `OPENROUTER_VISION_FALLBACK_MODELS` and logs `fallback_used = 1` in `ai_requests`.

### 6.3 Daily AI Insights (`OPENROUTER_TEXT_MODEL`)

- Triggered lazily when the user opens Today or requests refresh (`POST /api/daily/:date/insight`), **only** when `meal_count > 0` or health data exists for the day.
- Worker computes `input_hash = sha256(canonical_json({ date, totals, goals, workouts, 7d_weight_delta }))`.
- If `daily_summaries.insight_input_hash === input_hash` and `ai_insight` is present, return cached insight immediately ($0 OpenRouter cost).
- Prompt produces 2–3 grounded, encouraging, non-medical sentences (max 300 characters) referencing actual numbers (e.g., calorie balance vs. goal, protein intake, workout/steps). Never gives medical advice or diagnoses.

### 6.4 Cost Controls & Abuse Prevention

- **Backend-configurable models:** Changing `OPENROUTER_VISION_MODEL` or `OPENROUTER_TEXT_MODEL` in `wrangler.toml` / Cloudflare dashboard updates inference for all users immediately without mobile releases.
- **Per-user daily quotas (enforced via `ai_requests` counts):**
  - Default soft cap: `30` vision analyses/day and `8` daily insight generations/day per user (generous for real meals, blocks runaway loops or abuse).
  - Burst limit: max `10` vision calls per 5-minute window per user.
- **Cost observability:** Every OpenRouter response's `usage` object (`prompt_tokens`, `completion_tokens`, and OpenRouter reported cost when available) is stored in `ai_requests`, enabling simple SQL cost-per-DAU monitoring.

---

## 7. Apple Health and Android Health Connect Integration

### 7.1 Cross-Platform Abstraction

Mobile health access is encapsulated in `mobile/services/health/` behind a single interface:

```ts
export interface HealthProvider {
  isAvailable(): Promise<boolean>;
  requestPermissions(): Promise<HealthPermissionState>;
  getPermissionState(): Promise<HealthPermissionState>;
  syncIncremental(checkpoints: Record<string, string | null>): Promise<{
    records: NormalizedHealthRecord[];
    nextCheckpoints: Record<string, string | null>;
  }>;
}
```

Three implementations:
1. `HealthKitProvider` (iOS, `@kingstinct/react-native-healthkit`)
2. `HealthConnectProvider` (Android, `react-native-health-connect`)
3. `MockHealthProvider` (Expo Go / unit tests / Windows UI development)

### 7.2 Data Mapping & Aggregation Strategy

To prevent flooding Cloudflare D1 with thousands of raw per-second watch samples while preserving complete evening-review accuracy, fitlogr uses **discrete records for events** and **platform-aggregated buckets for high-frequency metrics**:

| Normalized `record_type` | Apple HealthKit Source | Android Health Connect Source | Granularity & `source_record_id` |
|---|---|---|---|
| `weight` | `HKQuantityTypeIdentifierBodyMass` | `WeightRecord` | Discrete sample; platform record UUID |
| `workout` | `HKWorkoutType` | `ExerciseSessionRecord` | Discrete session; platform record UUID (`metadata_json` stores activity type, duration, workout kcal, distance, avg HR) |
| `active_calories` | `HKStatisticsCollectionQuery` (`ActiveEnergyBurned`, cumulativeSum) | `aggregateGroupByPeriod` (`ActiveCaloriesBurnedRecord`) | Daily local-date bucket (`agg:active_kcal:YYYY-MM-DD`) |
| `resting_calories` | `HKStatisticsCollectionQuery` (`BasalEnergyBurned`, cumulativeSum) | `aggregateGroupByPeriod` (`BasalMetabolicRateRecord`) | Daily local-date bucket (`agg:resting_kcal:YYYY-MM-DD`) |
| `steps` | `HKStatisticsCollectionQuery` (`StepCount`, cumulativeSum) | `aggregateGroupByPeriod` (`StepsRecord`) | Daily local-date bucket (`agg:steps:YYYY-MM-DD`) |
| `resting_heart_rate` | `HKQuantityTypeIdentifierRestingHeartRate` | `RestingHeartRateRecord` | Daily latest/average (`agg:rhr:YYYY-MM-DD`) |
| `heart_rate_summary` | `HKStatisticsCollectionQuery` (`HeartRate`, discreteMin/Avg/Max) | `aggregate` (`HeartRateRecord` min/avg/max) | Daily summary (`agg:hr:YYYY-MM-DD`, min/max in `metadata_json`) |

**Why Platform Aggregation Wins:**
- Both Apple HealthKit and Android Health Connect natively deduplicate overlapping sources (e.g., iPhone + Apple Watch or Pixel Watch + phone step counter) inside their aggregate APIs.
- Reduces D1 writes from ~50,000 rows/day/user to **~6–10 rows/day/user**, keeping D1 solidly inside low-cost limits while remaining 100% accurate.

### 7.3 Preventing Calorie Double-Counting

- **Core Formula:**
  - `total_calories_out_kcal = active_calories_kcal + resting_calories_kcal`
  - `calorie_balance_kcal = calories_in_kcal - total_calories_out_kcal`
- **Workout Rule:** HealthKit's `ActiveEnergyBurned` and Health Connect's `ActiveCaloriesBurned` already include calories burned during workouts recorded by watches and fitness apps. Therefore, `workout` records store their `workout_kcal` in `metadata_json` for display on workout cards, and are **never added on top of** `active_calories_kcal`.
- **Fallback for Missing Resting/Active Data:** If a user's tracker writes workouts with calories on a day where `active_calories_kcal === 0` (rare third-party manual workout apps that omit active energy samples), the dashboard displays workout calories separately and notes incomplete tracker energy data rather than inventing resting calories.
- **Timezones:** Aggregation buckets align strictly to the user's current local midnight-to-midnight (`YYYY-MM-DD`) so evening reviews match Apple Fitness / Google Fit daily rings.

### 7.4 Sync Cadence & OS Background Constraints

- **Foreground Sync (Primary, Guaranteed):** Runs automatically on app launch, foreground return (debounced to >= 5 min), and manual pull-to-refresh. Always syncs the last 3 local days of aggregated buckets (to capture delayed watch/scale uploads) plus incremental changes since the saved cursor (`HKAnchoredObjectQuery` anchor on iOS; `getChangesToken` on Android; initial sync pulls trailing 30 days).
- **Background Sync (Best-Effort):**
  - iOS: `HKObserverQuery` + `enableBackgroundDelivery` where permitted, syncing via `expo-background-fetch` when woken.
  - Android: `expo-background-fetch` / WorkManager when `READ_HEALTH_DATA_IN_BACKGROUND` is granted (optional permission, never blocks onboarding).
- Because OS background execution can be throttled (Low Power Mode, OEM battery savers), foreground sync completes in < 2 seconds so the evening review is always current on open.

---

## 8. Security and Privacy

### 8.1 Data Flow & Privacy Boundaries

| Data Category | Stored on Device | Stored in Cloudflare D1 | Sent to OpenRouter | Stored in Google Photos |
|---|---|---|---|---|
| Non-food camera photos | Yes (user's library) | **Never** (only skipped locally if pre-filtered; non-meal false positives record hash/status only, no image) | Only if candidate passes local filter + user consent (EXIF/GPS stripped) | **Never** |
| Confirmed meal photos | Yes (user's library + clearable thumb cache) | **Never** (only persistent `google_media_item_id` & hashes) | Ephemeral inference only (`data_collection: "deny"`) | Yes (`fitlogr` album, user-owned) |
| Health & nutrition records | Encrypted OS storage / SQLite cache | Yes (authoritative, user-isolated) | Daily aggregate totals only (no name/email/device ID) for daily insight | **Never** |
| Google OAuth refresh token | **Never** | Yes, **AES-256-GCM encrypted** | **Never** | Used by Worker for Photos API |
| fitlogr session tokens | `expo-secure-store` (Keychain/Keystore) | Refresh token **SHA-256 hash only** | **Never** | **Never** |

### 8.2 Cryptographic & Auth Controls

- **OAuth Token Encryption at Rest:**
  - Algorithm: Web Crypto API `AES-GCM` (256-bit key decoded from Base64 `TOKEN_ENCRYPTION_KEY`).
  - IV: Fresh cryptographically random 96-bit (12-byte) IV (`crypto.getRandomValues(new Uint8Array(12))`) generated for every single write.
  - Additional Authenticated Data (AAD): UTF-8 bytes of `fitlogr:oauth:${user_id}:google:v${key_version}`, binding ciphertext to the exact user so rows cannot be replayed across users.
  - Key Rotation: `key_version` column on `user_oauth_tokens` enables seamless rotation (support previous key env var briefly during migration, re-encrypt on next token refresh).
- **Session Signing & Rotation:**
  - Access tokens: Compact JWT signed with HS256 using `SESSION_SECRET` (1-hour TTL, `sub = user_id`, `sid = session_id`, `did = device_id`).
  - Refresh tokens: 256-bit random opaque token stored in `expo-secure-store`, persisted only as `SHA-256` hash in `user_sessions`. Rotated on every `/api/auth/refresh`; reuse of an already-rotated token revokes all sessions for that device.
- **Transport Security:** All traffic uses HTTPS/TLS 1.3 via Cloudflare (`https://fitlogr.com`).
- **Tenant Isolation:** Every D1 query in `worker/src/db/*` accepts `userId` from verified JWT context (never trusting client-supplied `user_id`) and enforces `WHERE user_id = ?`. Dedicated integration tests verify cross-user access returns `404`/`403`.
- **Log Redaction:** Centralized logger strips `Authorization`, `Cookie`, query tokens, email addresses, health metrics, and image payloads. Zero secret values ever enter code, logs, or mobile bundles.
- **Pre-Launch Secret Hygiene:** `.env.example` contains placeholder keys only. Fresh production `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET` are generated locally via CSPRNG and uploaded via `wrangler secret put` before public launch.

### 8.3 Account Export, Deletion & Platform Compliance

- **Data Export (`GET /api/account/export`):** Exports a clean, human-readable JSON file containing profile, settings, goals, meals, meal items, photo metadata (with Google Photos media item IDs and hashes), health records, and daily summaries.
- **Account Deletion (`DELETE /api/account`):**
  1. Best-effort revocation of the user's Google OAuth token via `https://oauth2.googleapis.com/revoke`.
  2. Transactional `DELETE FROM users WHERE id = ?` in D1 (cascades across all 13 dependent tables).
  3. Mobile clears local SQLite database, `expo-secure-store`, and thumbnail cache.
  4. **Explicitly does NOT delete** the user's `fitlogr` album or any photos inside Google Photos.
- **Platform & Policy Compliance:**
  - **Google API Services User Data Policy:** Minimal required scopes, Limited Use disclosure on `https://fitlogr.com/privacy`, Google OAuth App Verification (required for external audience with Photos scopes) completed before public launch.
  - **Apple App Store:** HealthKit usage strings (`NSHealthShareUsageDescription`), no HealthKit data in iCloud/analytics/ads, in-app account deletion (Guideline 5.1.1(v)), and Sign in with Apple fallback path ready if requested during review.
  - **Google Play & Health Connect:** Privacy policy accessible directly from Android Health Connect permission screen (`ACTION_SHOW_PERMISSIONS_RATIONALE`), Health Connect declaration form completed in Play Console, accurate Data Safety disclosures.
  - **AI & Privacy:** Explicit user consent before cloud photo analysis; zero selling of health data; zero targeted advertising; OpenRouter zero-data-retention / no-training routing preference enabled.

---

## 9. Testing and Deployment Strategy

### 9.1 Automated Testing Pyramid

All automated tests run via **Vitest** (fast, native TypeScript, works identically on Windows and Linux CI):

| Level | Tooling | Scope & Critical Test Cases |
|---|---|---|
| **Shared Unit Tests** | Vitest (`shared/`) | Calorie/macro total recomputation, Atwater sanity checks, calorie balance math, workout non-double-counting, timezone `local_date` boundaries (DST + travel), Zod schema validation |
| **Worker Unit & Integration Tests** | Vitest + `@cloudflare/vitest-pool-workers` (Miniflare + real D1 SQLite) | Runs actual `worker/migrations/*.sql`; AES-256-GCM encrypt/decrypt + tampered AAD rejection; OAuth state/PKCE/exchange single-use enforcement; refresh token rotation & reuse detection; strict cross-user tenant isolation on every endpoint; photo hash dedupe; OpenRouter schema validation + fallback model retry; Google Photos album recreation / revoked token / quota exceeded flows; account export & cascading deletion |
| **Mobile Unit & Component Tests** | Jest/Vitest + `@testing-library/react-native` | Local SQLite outbox retry & conflict resolution (`is_user_edited` preservation); dHash Hamming near-duplicate filtering; `HealthProvider` normalization; Today dashboard & Meal editor states (loading, offline, revoked Google banner, AI estimate edit) |
| **Physical Device E2E Checklist** | Physical iPhone + Physical Android (EAS Dev/Preview Builds) | Full Google OAuth sign-in & reconnect after manual revocation in Google Account settings; take real meal photo -> auto-discover -> analyze -> verify photo appears in Google Photos `fitlogr` album; sync Apple Watch / Health Connect test data (verify no workout double-count); airplane-mode edit meal -> reconnect -> verify sync on second device; account export & account deletion (verify Google Photos intact) |

### 9.2 Environments & Deployment Pipeline

| Environment | Worker & D1 | Mobile Client | Purpose |
|---|---|---|---|
| **Local Dev (Windows)** | `wrangler dev --local` (local D1) | Expo Go / EAS Development Build over LAN/tunnel | Daily feature development with Fast Refresh |
| **Preview / Staging (Optional)** | `wrangler.toml` `[env.staging]` Worker + separate D1 DB | EAS `preview` build (TestFlight Internal / Play Internal Testing) | Pre-release validation & Google OAuth verification testing |
| **Production** | `https://fitlogr.com` (Account `42aad73fe98811972eccd8907196d722`, Zone `4da8c98a66722b963535773610a7d0d8`) | EAS `production` build (App Store / Google Play) | Public users |

### 9.3 GitHub Actions CI/CD

1. **`.github/workflows/ci.yml` (on every PR & push to `main`):**
   - `npm ci`
   - `npm run typecheck` across `shared/`, `worker/`, `mobile/`
   - `npm run lint`
   - `npm test` (shared unit tests + Worker Miniflare/D1 integration tests + mobile unit tests)
   - Verify D1 migrations apply cleanly on a fresh local D1 database.
2. **`.github/workflows/deploy-worker.yml` (on push to `main` touching `worker/` or `shared/`, or manual dispatch):**
   - Uses `CLOUDFLARE_API_TOKEN` from GitHub Actions Secrets.
   - Runs `wrangler d1 migrations apply fitlogr-db --remote`.
   - Runs `wrangler deploy` (deploys Worker + static site `worker/public/`).
   - Executes post-deploy smoke test: `curl -fsS https://fitlogr.com/api/health` verifying `ok: true` and `db_ok: true`.
3. **Mobile Builds & Releases:**
   - Triggered manually or via release tag using `eas build --platform ios|android --profile preview|production` and `eas submit`.
   - Backward-compatibility rule: Worker API changes must always remain compatible with older released mobile app versions; database migrations are strictly additive/expand-and-contract.

### 9.4 Observability & Operations

- **Cloudflare Workers Logs & Analytics:** Track request volume, error rates (4xx/5xx), and p95 latency per route without logging PII.
- **AI Spend & Health Queries:** Scheduled or ad-hoc D1 queries against `ai_requests` track daily token volume, cost per active user, fallback rate, and schema-error rate.
- **Graceful Degradation:** If OpenRouter is temporarily down, mobile keeps candidate photos in `sync_outbox` and retries automatically with backoff; users can still view all cached meals, health stats, and add/edit meals manually.

---

## 10. Implementation Phases, Task Dependencies, and Acceptance Criteria

Phases are ordered by technical dependency so every milestone produces a working, testable vertical slice. (No calendar estimates are used; scope is expressed in subsystems, dependencies, and exit criteria.)

### 10.1 Dependency Graph

```text
Phase 0: Monorepo, Shared Schemas & CI
   |
   +--> Phase 1: Worker Core, D1 Migrations & Static Site (fitlogr.com)
           |
           +--> Phase 2: Google OAuth, Encrypted Tokens & Sessions
                   |
                   +--> Phase 3: Mobile Shell, Auth UI, Local SQLite & Sync Core
                           |
                           +--> Phase 4: Photo Discovery, OpenRouter Vision & Google Photos
                           |
                           +--> Phase 5: Apple HealthKit & Android Health Connect
                                   |
                                   v (requires Phase 4 + Phase 5)
                           Phase 6: Evening Review Dashboard, Trends, Goals & AI Daily Insights
                                   |
                                   v
                           Phase 7: Export/Delete, Google Picker Import, Hardening & Store Launch
```

*(Note: Phase 4 and Phase 5 can proceed in parallel once Phase 3 is complete.)*

### 10.2 Detailed Phases & Acceptance Criteria

#### Phase 0: Monorepo Bootstrap, Shared Package & CI Foundation
- **Scope:** Root npm workspaces (`shared/`, `worker/`, `mobile/`), TypeScript strict configs, linting/formatting, `.env.example`, `.gitignore`, `@fitlogr/shared` Zod schemas & nutrition calculation helpers, GitHub Actions CI workflow.
- **Dependencies:** None.
- **Acceptance Criteria:**
  - `npm ci`, `npm run typecheck`, `npm run lint`, and `npm test` pass cleanly on Windows and Linux CI.
  - `.env.example` documents every variable and secret name from `README.md` with zero real values.
  - Shared nutrition total & calorie balance unit tests pass.

#### Phase 1: Cloudflare Worker Core, D1 Schema & Static Website
- **Scope:** Hono API skeleton, structured logging, error/rate-limit middleware, `worker/migrations/0001_initial.sql` (all 12 core + 2 auth support tables), `GET /api/health`, static landing page + `/privacy` + `/terms` + `/support` in `worker/public/`, `wrangler.toml`, and `deploy-worker.yml`.
- **Dependencies:** Phase 0.
- **Acceptance Criteria:**
  - Local `wrangler dev` and `@cloudflare/vitest-pool-workers` apply `0001_initial.sql` cleanly with foreign keys enabled.
  - `https://fitlogr.com/`, `/privacy`, `/terms`, and `GET https://fitlogr.com/api/health` return `200 OK` after deployment.
  - D1 query layer enforces `user_id` scoping across all table helpers.

#### Phase 2: Google Authentication, Encrypted Token Storage & Sessions
- **Scope:** AES-256-GCM crypto module (`TOKEN_ENCRYPTION_KEY`, random 96-bit IV, user-bound AAD), Google OIDC JWKS verification, `/api/auth/google/start`, `/api/auth/google/callback`, `/api/auth/exchange`, `/api/auth/refresh`, `/api/auth/logout`, `/api/me`, `/api/settings` (`GET`/`PUT`), automatic Google access token refresh, and revoked-grant detection.
- **Dependencies:** Phase 1 + Google Cloud `fitlogr-app` OAuth client credentials configured in Worker Secrets.
- **Acceptance Criteria:**
  - End-to-end OAuth flow works with PKCE, state, nonce, and 60s single-use app exchange code.
  - Refresh tokens stored in D1 are verified encrypted with unique IVs per write; tampered AAD fails decryption.
  - Refresh token rotation works and detects token reuse by revoking the session.
  - Integration tests prove User A cannot read or mutate User B's profile or settings.

#### Phase 3: Mobile App Shell, Auth Flow, Local SQLite & Sync Core
- **Scope:** Expo Router layout (`(auth)`, `(tabs)`, `modal`), onboarding consent & Google sign-in via `expo-web-browser`, `expo-secure-store` token persistence + automatic 401 refresh, local `expo-sqlite` mirror + `sync_outbox`, `GET /api/sync/changes`, `GET/PUT /api/settings`, and Windows Expo Go dev verification.
- **Dependencies:** Phase 2.
- **Acceptance Criteria:**
  - Developer can run mobile app from Windows with Fast Refresh on physical iOS and Android devices via Expo Go.
  - Signing in with Google persists session across app restarts; logging out wipes local SQLite and SecureStore.
  - Editing settings offline queues in `sync_outbox` and synchronizes automatically upon reconnect; changes appear on a second device.

#### Phase 4: Photo Discovery, Deduplication, OpenRouter AI & Google Photos
- **Scope:** Mobile `expo-media-library` incremental scanner, SHA-256 + 64-bit dHash near-duplicate detector, image resize/EXIF-strip compression, optional TFLite on-device food pre-filter (EAS build), Worker `/api/photos/check-hashes`, `/api/photos/analyze`, `/api/photos/urls`, `/api/photos/:id/exclude`, `/api/meals/*` CRUD + manual edit protection, OpenRouter multimodal client with Zod validation + backend total calculation + model fallback + `ai_requests` logging, Google Photos `fitlogr` album creation & two-step upload.
- **Dependencies:** Phase 3 + `OPENROUTER_API_KEY` and `OPENROUTER_VISION_MODEL` configured.
- **Acceptance Criteria:**
  - Taking a meal photo on a physical phone discovers, deduplicates, analyzes via OpenRouter, uploads to the user's `fitlogr` Google Photos album, and renders the meal + thumbnail across two signed-in devices.
  - Non-food photos are skipped locally (or rejected by AI) and never uploaded to Google Photos; no image binaries exist in D1 or Worker storage.
  - Manual edits to meal items set `is_user_edited = 1`, recalculate totals on the backend, and survive subsequent syncs.
  - Excluded photos are removed from daily totals and never re-imported.
  - Revoked Google OAuth, deleted Google Photos album/item, and quota-exhausted states are handled gracefully without losing meal records.

#### Phase 5: Apple HealthKit & Android Health Connect Integration
- **Scope:** `HealthProvider` abstraction, `HealthKitProvider` (iOS) + `HealthConnectProvider` (Android) + `MockHealthProvider` (Expo Go), EAS `development` build profile with HealthKit/Health Connect Expo config plugins, `/api/health/sync` & `/api/health/records`, daily aggregation & workout non-double-counting logic, incremental checkpoints (`sync_checkpoints`), foreground + best-effort background sync.
- **Dependencies:** Phase 3 (can run in parallel with Phase 4).
- **Acceptance Criteria:**
  - EAS development builds install and run on physical iPhone (HealthKit) and physical Android device (Health Connect) built entirely from Windows via EAS cloud builds.
  - Weight, active calories, resting calories, workouts, steps, and heart rate sync incrementally without duplicates across repeated syncs.
  - Days with both recorded workouts and active energy samples do not double-count workout calories in `total_calories_out_kcal`.
  - Daily totals align with the user's local timezone.

#### Phase 6: Evening Review Dashboard, Trends, Goals & AI Daily Insights
- **Scope:** Worker `daily_summaries` recomputation service, `GET /api/daily`, `POST /api/daily/:date/insight` (OpenRouter `OPENROUTER_TEXT_MODEL` with `insight_input_hash` caching), Today evening-review dashboard UI, Meals history screen, Trends charts (7d/30d/90d weight, calorie balance, macros), Goal configuration UI, and manual meal quick-add fallback.
- **Dependencies:** Phase 4 + Phase 5.
- **Acceptance Criteria:**
  - Opening Today displays accurate calorie intake, active/resting expenditure, deficit/surplus, macros, meal photos, workouts, weight, and a concise AI daily insight in under 1 second from local cache (updating seamlessly when sync completes).
  - Re-opening Today when data has not changed triggers zero OpenRouter insight calls (verified via `ai_requests`).
  - Navigating across past dates and viewing 7d/30d/90d trends works offline from SQLite cache.

#### Phase 7: Export/Delete, Historical Picker Import, Hardening & Launch Readiness
- **Scope:** `GET /api/account/export`, `DELETE /api/account` (cascading D1 deletion + Google token revocation without deleting Google Photos), optional Google Photos Picker historical import (`/api/photos/picker/*` + incremental `photospicker.mediaitems.readonly` scope), rate-limit & abuse hardening, security audit, fresh production key rotation, Google OAuth App Verification submission, Apple TestFlight / App Store & Google Play Health Connect submission prep.
- **Dependencies:** Phase 6.
- **Acceptance Criteria:**
  - Export downloads a complete, valid JSON archive of all user fitlogr data.
  - Deleting an account removes 100% of user rows in D1 and wipes local device state while leaving the user's Google Photos `fitlogr` album and photos completely untouched.
  - Optional historical import lets a user select past photos via Google Photos Picker and analyzes/imports them with deduplication.
  - All automated CI tests, cross-user isolation tests, and physical iOS/Android E2E checks pass; production `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET` are freshly generated and deployed.

---

## 11. Trade-Offs and Open Decisions for Approval

The following decisions are intentionally called out for review before Phase 0 implementation begins:

1. **Worker Web Framework (`Hono` vs. raw Fetch router):** This design recommends **Hono** (~14 KB, zero native deps, first-class Cloudflare Workers & Zod integration) for clean middleware, routing, and testing without introducing heavyweight abstractions.
2. **Initial OpenRouter Model Defaults:** Models are fully backend-configurable via `OPENROUTER_VISION_MODEL` and `OPENROUTER_TEXT_MODEL`. Recommended cost-effective starting defaults:
   - `OPENROUTER_VISION_MODEL`: `google/gemini-2.5-flash-lite` (fallback: `openai/gpt-4o-mini`)
   - `OPENROUTER_TEXT_MODEL`: `google/gemini-2.5-flash-lite` (fallback: `openai/gpt-4o-mini`)
   *(Confirm preferred starting models before Phase 4.)*
3. **On-Device Food Pre-Filter Rollout Timing:** Phase 4 starts with zero-dependency heuristics (screenshot/folder/aspect/hash/dHash dedupe, working in both Expo Go and EAS builds) plus an optional `"Confirm before analyzing"` toggle, and layers in the quantized on-device TFLite binary food classifier in EAS builds. Confirm if you want the TFLite binary classifier included in initial Phase 4 or deferred to a Phase 4b optimization once real camera-roll false-positive rates are measured.
4. **D1 Database & Staging Setup:** Recommend provisioning two Cloudflare D1 databases (`fitlogr-db-staging` and `fitlogr-db-prod`) or a single production DB + local Wrangler D1 during pre-launch. A single production D1 + local Miniflare/Wrangler D1 keeps setup minimal until external beta users arrive.
5. **Sign in with Apple Deferral:** Per `README.md`, Google OAuth is the sole login method for v1, with `users.apple_sub` already reserved in the schema so Sign in with Apple can be added cleanly only if Apple App Store Review explicitly requires it.
6. **Health Data Granularity:** Aggregating steps, active/resting calories, and heart rate into daily local-date buckets via HealthKit / Health Connect native aggregate APIs dramatically reduces D1 write costs and handles multi-device deduplication automatically, at the trade-off of not showing minute-by-minute intraday heart-rate/calorie graphs in v1.
