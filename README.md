# fitlogr

**100% free AI fitness tracking for busy people.**

fitlogr makes calorie and fitness tracking effortless. No tedious food logging, manual calorie counting, or complicated workout tracking.

## How It Works

1. **Take a photo of every meal before eating.** Use your phone's regular camera. fitlogr automatically discovers meal photos and uses AI to estimate calories and nutritional content.
2. **Wear a fitness watch throughout the day.** fitlogr automatically synchronizes weight, calorie burn, workouts, and activity data from Apple Health or Android Health Connect.
3. **Review your daily progress in seconds each evening.** Understand your calorie balance, nutrition, and progress toward your fitness goals.

## Product Principles

- **100% free:** No subscriptions, premium tiers, or paywalls.
- **Friction-free:** Minimize manual data entry and user interactions.
- **AI-first:** Automatically turn photos and fitness data into useful insights.
- **Cross-platform:** Support iOS and Android with seamless synchronization.
- **Privacy-first:** Keep meal photos on the phone. Send a photo for analysis only when it looks like food.
- **Cost-efficient:** Minimize operating costs to keep fitlogr free.

Users should not need to open fitlogr after every meal or workout.

## Core Features

### Nutrition Tracking

- Automatically discover meal photos from the device's photo library.
- Use AI to identify food, estimate portion sizes, calories, protein, carbohydrates, and fat.
- Automatically organize meals by capture date and time.
- Keep meal photos on the phone. The server does not store photo files.
- Detect duplicate photos and meals.
- Allow users to correct nutritional estimates or exclude photos.

### Fitness Tracking

Automatically synchronize available health data from Apple HealthKit on iOS and Health Connect on Android:

- Body weight
- Active and resting calories burned
- Workouts and exercise duration
- Steps and heart rate

Support compatible fitness watches, fitness trackers, and smart scales through platform health integrations.

### Fitness Dashboard

- Daily calorie intake, expenditure, and surplus or deficit.
- Daily macronutrient breakdown.
- Meal photos and nutritional estimates.
- Workout and activity summaries.
- Weight trends and historical progress.
- Configurable weight, calorie, and nutritional goals.
- Concise AI-generated daily insights.

## User Accounts & Synchronization

- Require a Google account for identity (name and email). The iPhone app does not ask for Google Photos access.
- Use the Google account as the shared identity across devices.
- Allow users to capture meals on one device and review progress on another.
- Synchronize nutrition records, health data, goals, preferences, and historical progress.
- Use local caching for offline access and synchronize when connectivity returns.
- Prevent duplicate records across devices.
- Support account deletion and data export.
- Support alternative authentication if required by Apple App Store policies.

## App Environment

Maintain a single cross-platform mobile codebase.

| Component | Technology |
|---|---|
| Development IDE | Cursor |
| Mobile framework | React Native |
| Development platform | Expo |
| Language | TypeScript |
| Navigation | Expo Router |
| Authentication | Google OAuth 2.0 |
| Photo discovery | Expo MediaLibrary |
| Photo storage | On the phone (Apple Photos on iPhone) |
| Local database | Expo SQLite |
| Secure storage | Expo SecureStore |
| iOS health integration | Apple HealthKit |
| Android health integration | Health Connect |
| Development builds | Expo EAS |
| iOS distribution | Apple TestFlight / App Store |
| Android distribution | Google Play |
| Source control | GitHub |

Support development on Windows without requiring a local Mac. Use Expo Go where compatible and Expo EAS development builds for native integrations. Support Fast Refresh and testing on physical iOS and Android devices throughout development.

## Production Environment

The website and backend API are served by a Cloudflare Worker hosted on fitlogr.com.

| Component | Configuration |
|---|---|
| Website | https://fitlogr.com |
| API | https://fitlogr.com/api/ |
| Hosting | Cloudflare Workers |
| Backend language | TypeScript |
| Database | Cloudflare D1 |
| Photo storage | On the phone. The worker keeps no photo files. |
| AI inference | OpenRouter |
| Deployment | Cloudflare Wrangler |
| CI/CD | GitHub Actions |

### Cloudflare Configuration

- Zone ID: `4da8c98a66722b963535773610a7d0d8`
- Account ID: `42aad73fe98811972eccd8907196d722`
- API Token: `CLOUDFLARE_API_TOKEN`

Reuse existing infrastructure where appropriate.

### Google Cloud Configuration

- Project ID: `fitlogr-app`
- OAuth application name: `fitlogr`
- OAuth audience: External
- Authorized origin: `https://fitlogr.com`
- Redirect URI: `https://fitlogr.com/api/auth/google/callback`

Required integrations:

- Google OAuth 2.0 / OpenID Connect

Legacy integrations, used only by app builds older than 0.2.0:

- Google Photos Library API
- Google Photos Picker API

Use the same centralized Web OAuth client for sign-in across iOS and Android.

### OpenRouter Configuration

- Website: https://openrouter.ai
- API Base URL: `https://openrouter.ai/api/v1`
- API Key: `OPENROUTER_API_KEY`

Use OpenRouter for cloud-based photo analysis, nutritional estimation, and AI-generated fitness insights. AI models must be configurable on the backend without requiring mobile application updates.

## Credentials & Secrets

Use the following configured Cursor secrets:

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare deployment |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Web OAuth client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Web OAuth client secret |
| `OPENROUTER_API_KEY` | AI inference |
| `TOKEN_ENCRYPTION_KEY` | Encrypt stored OAuth tokens |
| `SESSION_SECRET` | Secure application sessions |

Additional configuration:

```dotenv
CLOUDFLARE_ACCOUNT_ID=42aad73fe98811972eccd8907196d722
CLOUDFLARE_ZONE_ID=4da8c98a66722b963535773610a7d0d8

GOOGLE_CLOUD_PROJECT_ID=fitlogr-app
GOOGLE_OAUTH_REDIRECT_URI=https://fitlogr.com/api/auth/google/callback
GOOGLE_PHOTOS_ALBUM_NAME=fitlogr

OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_VISION_MODEL=
OPENROUTER_TEXT_MODEL=

APP_URL=https://fitlogr.com
API_BASE_URL=https://fitlogr.com/api
```

- Reuse the exact configured secret names.
- Configure runtime credentials through Cloudflare Worker Secrets.
- Configure deployment credentials through GitHub Actions Secrets.
- Never commit secret values or expose them to mobile applications.
- Maintain a documented `.env.example`.
- Generate fresh production encryption and session keys locally before public launch.

## System Architecture

```text
            fitlogr iOS / Android
             React Native + Expo
                      |
          +-----------+-----------+
          |                       |
    Device Photos           Health Data
    Local Discovery         HealthKit / HC
          |                       |
          +-----------+-----------+
                      |
                   HTTPS API
                      |
              Cloudflare Worker
                 fitlogr.com
                      |
       +--------------+--------------+
       |              |              |
 Cloudflare D1   Google sign-in   OpenRouter
 User Accounts   Identity only    AI Analysis
 Fitness Data                     Nutrition
 Meal Records                     Insights
```

Cloudflare D1 is the authoritative database for user and fitness records. Meal photos stay on the phone, in Apple Photos.

Do not maintain permanent photo storage on fitlogr infrastructure.

## Google Authentication

- Use Google OAuth 2.0 authorization code flow with secure system-browser authentication.
- Validate OAuth state, identity tokens, and applicable PKCE parameters.
- Identify users by their persistent Google account subject identifier (`sub`).
- Request offline access and automatically refresh Google access tokens.
- Encrypt stored OAuth refresh tokens using AES-256-GCM with a unique random IV per encryption operation.
- Use `TOKEN_ENCRYPTION_KEY` as a Base64-encoded 256-bit encryption key.
- Use `SESSION_SECRET` for secure session signing where applicable.
- Maintain secure application sessions independently of Google access tokens.
- Handle revoked permissions and account reconnection gracefully.

## Photo Discovery

The iPhone app reads Apple Photos on the device. A photo the on-device filter rejects never leaves the phone.

### Photo Processing

1. Discover new photos from the iPhone photo library.
2. Decide on the phone which photos look like food.
3. Deduplicate photos using content hashes and image fingerprints.
4. Compress a photo that passed the filter and submit it for AI analysis.
5. Keep the photo on the phone. Store the nutritional estimate in Cloudflare D1.
6. Show the meal from the phone's copy of the photo.

Older app builds can still opt into a Google Photos album upload. The iPhone app sends `upload_to_google_photos: false`. Sign-in from this app requests only `openid`, `email`, and `profile`.

### Google Photos Integration (legacy)

The iPhone app from 0.2.0 on does not use any of this. The server keeps it for older builds.

- Automatically create a dedicated `fitlogr` album.
- Upload meal photos using the Google Photos Library API.
- Store persistent album and media item IDs rather than temporary image URLs.
- Retrieve fresh image URLs when displaying historical meals.
- Use Google Photos Picker for optional historical photo imports.
- Handle deleted photos, revoked permissions, and exhausted storage quotas.
- Inform users that normal Google Photos backups may create additional copies of meal photos.

Google Photos automatic backup of the entire device library is not required.

### OAuth Scopes

Requested by the iPhone app (0.2.0 and later):

```text
openid
email
profile
```

Requested only by older builds, for the legacy Google Photos album and picker:

```text
https://www.googleapis.com/auth/photoslibrary.appendonly
https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata
https://www.googleapis.com/auth/photospicker.mediaitems.readonly
```

## AI Processing

All OpenRouter requests must originate from the Cloudflare Worker.

Use multimodal AI models to:

- Determine whether an image contains a meal.
- Identify individual food items.
- Estimate portion sizes and weights.
- Estimate calories and macronutrients.
- Generate concise daily fitness insights.

Require validated structured JSON responses containing:

- Food classification and confidence.
- Meal name.
- Individual food items and estimated quantities.
- Calories, protein, carbohydrates, and fat per item.
- Total nutritional estimates.

Calculate nutritional totals on the backend. Clearly present AI-generated values as estimates and allow manual corrections.

### Cost Optimization

- Prefer inexpensive, accurate multimodal models.
- Filter non-food photos locally wherever possible.
- Compress images before inference.
- Cache results and avoid duplicate processing.
- Configure model fallbacks.
- Track inference costs per request and user.
- Apply rate limits and abuse prevention.
- Avoid repeatedly generating unchanged daily summaries.

## Health Data & Synchronization

- Read authorized data from Apple HealthKit and Android Health Connect.
- Normalize health records into a common cross-platform format.
- Preserve source identifiers, timestamps, units, and device information.
- Distinguish active calories, resting calories, and total calories burned.
- Avoid double-counting workouts already included in daily activity totals.
- Synchronize incrementally whenever the app opens and in the background where supported.
- Maintain synchronization checkpoints per device and data source.
- Support offline caching, automatic retries, and manual synchronization.
- Preserve user corrections during subsequent synchronization.
- Use the user's local time zone for daily totals.

The evening review experience must remain functional even when background synchronization is restricted by the operating system.

## Database Design

Use Cloudflare D1 with version-controlled migrations.

Suggested core tables:

| Table | Purpose |
|---|---|
| `users` | User identities and profiles |
| `user_settings` | Preferences and fitness goals |
| `user_devices` | Connected devices |
| `user_oauth_tokens` | Encrypted OAuth credentials |
| `user_google_photos` | Google Photos album information |
| `photos` | Media IDs, hashes, and processing status |
| `meals` | Meal records and nutritional totals |
| `meal_items` | Individual food items |
| `health_records` | Normalized fitness and health data |
| `daily_summaries` | Aggregated daily statistics |
| `sync_checkpoints` | Synchronization state |
| `ai_requests` | AI usage and cost tracking |

Enforce user-level data isolation, appropriate indexes, foreign keys, and deduplication constraints.

Do not store photo binaries or unencrypted OAuth tokens in D1.

## Repository Structure

```text
fitlogr/
├── mobile/             # React Native / Expo app
│   ├── app/
│   ├── components/
│   ├── services/
│   ├── hooks/
│   └── assets/
├── worker/             # Website and backend API
│   ├── src/
│   ├── public/
│   ├── migrations/
│   └── wrangler.toml
├── shared/             # Shared TypeScript types and schemas
├── docs/
├── .github/workflows/
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

Use a monorepo with shared types, validation schemas, and utilities. Adapt the structure to the existing repository where appropriate.

## Privacy & Security

- Request only necessary Google, photo, and health permissions.
- Clearly disclose how photos and health data are processed.
- Avoid transmitting unrelated personal photos.
- Obtain appropriate consent before sending candidate photos to cloud AI providers.
- Store meal photos in the user's own Google Photos account.
- Encrypt sensitive credentials at rest and all data in transit.
- Authenticate and authorize all private API endpoints.
- Never expose server-side secrets or log sensitive user data.
- Never sell personal health information or use it for targeted advertising.
- Do not use personal photos or health data for AI training without appropriate consent and authorization.
- Allow users to export and delete their fitlogr data.
- Do not automatically delete Google Photos content when a fitlogr account is deleted.
- Comply with Google API policies, Apple App Store policies, Google Play policies, and applicable privacy regulations.

## Development Guidelines

- Prioritize simplicity, automation, and speed.
- Maintain a single cross-platform codebase.
- Write reusable, strongly typed, modular code.
- Reuse existing infrastructure and configured secrets.
- Minimize dependencies and recurring operating expenses.
- Test authentication, photo processing, health integrations, synchronization, and data isolation.
- Test on physical iOS and Android devices.
- Maintain backward compatibility with released mobile applications.
- Complete required OAuth verification and platform permission reviews before public launch.
- Keep this README updated as the project evolves.

## Local Development

Install dependencies from the repository root with Node.js 22 or newer:

```bash
npm ci
```

### Mobile app (Expo Go)

```bash
npm run dev:mobile
```

Install the current Expo Go app from the App Store or Google Play, then scan the QR code. Log, Review, and Settings run on the phone with a local SQLite database and sample meals, so you can try the evening review without a Mac and without signing in. Fast Refresh works from Windows.

If the phone is not on the same network as the computer, start with a tunnel:

```bash
npm run dev:mobile -- --tunnel
```

Apple Health and Health Connect need an EAS development build. Expo Go uses the on-screen sample activity instead.

### iPhone build (EAS)

Automatic photo scanning, Apple Health and notifications need a native build. Expo Go cannot run them.

```bash
cd mobile
npx eas-cli build --platform ios --profile preview
```

EAS builds whatever is checked out, so check out the branch you mean to test first. Settings shows the version and the commit the build came from at the bottom of the screen. Raise `version` in `mobile/app.config.ts` whenever native code changes: the over-the-air update channel is keyed to the version, and an update published for an older build must not reach a newer one.

### Debugging a build on a phone

Settings → Debug logs shows one text report: the build commit, whether the on-device photo classifier is linked, permissions, changes waiting to sync, photo-log totals, recent passes, and the last 600 log lines (requests with status and timing, each photo's result, Apple Health wake-ups, errors). "Copy or share the report" opens the share sheet. The report holds no token, email address or photo. Log lines are written with `debugLog()` in `mobile/services/debugLog.ts`.

### API and website

```bash
npm run dev:worker
```

Wrangler serves the site and `http://127.0.0.1:8787/api/health`. `npm run dev:worker` uses a local D1 database (`wrangler --env local`), applies `worker/migrations`, and reports `db_ok: true` when that database answers `SELECT 1`.

Copy the secret names from `.env.example` into `worker/.dev.vars` before exercising Google sign-in locally. The production Worker config does not bind D1 until `CLOUDFLARE_API_TOKEN` can create `fitlogr-db`. A token that can deploy Workers but receives HTTP 401 from the D1 API must not be used to attach a missing database, or the live `fitlogr.com` deploy will fail.

Google sign-in uses the system browser. Expo Go returns through the `exp://` or `https://auth.expo.io` URL from `Linking.createURL('auth/callback')`. A native build returns through `fitlogr://auth/callback`. Both are allowlisted. Sample meals stay on the phone only while you are signed out. Signing in clears that preview and syncs the account. Signing out restores the sample day.

## Mission

Make fitness tracking so effortless that anyone can do it, regardless of how busy their life is.

**Take photos. Wear your watch. Know your progress.**

https://fitlogr.com
