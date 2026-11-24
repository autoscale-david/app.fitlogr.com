# fitlogr

**Free AI-powered fitness tracking for busy people.**

fitlogr is a 100% free AI fitness app designed to make calorie and fitness tracking as effortless as possible. No tedious food logging, manual calorie counting, or complicated workout tracking.

## How It Works

1. **Take a photo of every meal before eating.** Save your photos to Google Photos as usual. fitlogr discovers meal photos and uses AI to estimate calories and nutritional content.
2. **Wear a fitness watch throughout the day.** fitlogr automatically syncs available weight, calorie burn, workout, and activity data from Apple Health and Android Health Connect.
3. **Review your daily progress in seconds each evening.** See your calorie intake, calorie expenditure, nutritional balance, and progress toward your fitness goals.

## Product Principles

- **100% free:** No subscriptions, premium tiers, or paywalls.
- **Friction-free:** Minimize manual data entry and unnecessary interactions.
- **AI-first:** Automatically turn everyday photos and fitness data into actionable insights.
- **Cross-platform:** Support iOS and Android from a single codebase.
- **Cloud-connected:** Seamlessly synchronize fitness progress across devices.
- **Privacy-first:** Collect only the data necessary to provide the service.
- **Keep it simple:** Enable users to manage their fitness in less than one minute per day.

## User Requirements

All users are required to:

- Have a Google account.
- Sign into fitlogr using their Google account.
- Install Google Photos and enable automatic photo backup.
- Use the same Google account for fitlogr and Google Photos across all devices.
- Grant the necessary photo and health data permissions.

A compatible fitness watch and smart scale are recommended but not required.

## Authentication & Account Management

Google Sign-In is the primary authentication mechanism for fitlogr.

- Require Google account authentication during onboarding.
- Use Google OAuth 2.0 and OpenID Connect.
- Do not maintain a separate username and password system.
- Associate all user records with a unique, persistent account identifier based on the Google account's subject identifier.
- Support persistent login sessions across devices.
- Validate Google identity tokens on the backend.
- Support account deletion and data export.
- Account for Apple App Store authentication requirements before public distribution.

## Core Features

### Nutrition Tracking

- Google Photos as the user's primary cloud photo library.
- Automatic meal photo discovery through authorized device photo libraries.
- Google Photos Picker integration for importing cloud-only photos.
- AI-powered food recognition and portion estimation.
- Estimated calories, protein, carbohydrates, and fat.
- Automatic meal categorization by date and time.
- Duplicate photo and meal detection across devices.
- Manual correction of AI-generated estimates.
- Optional direct meal capture within fitlogr.
- Save photos captured within fitlogr to Google Photos with user authorization.

### Fitness Tracking

- Apple HealthKit integration on iOS.
- Health Connect integration on Android.
- Google Health API integration where appropriate.
- Automatic synchronization of available:
  - Body weight
  - Active calories burned
  - Resting calories burned
  - Workouts
  - Steps
  - Exercise duration
  - Heart rate
- Support compatible smartwatches, fitness trackers, and smart scales through platform health integrations.

### Daily Dashboard

- Total calories consumed.
- Total calories burned.
- Net calorie surplus or deficit.
- Daily protein, carbohydrate, and fat intake.
- Current weight and weight trends.
- Progress toward personal fitness goals.
- AI-generated daily summary.
- Recommended adjustments for the following day.

### Historical Progress

- Daily, weekly, monthly, and yearly views.
- Weight trends.
- Calorie intake and expenditure trends.
- Nutritional trends.
- Fitness activity trends.
- Progress toward target weight.

### Cross-Device Synchronization

Users should be able to switch between iPhone and Android devices without losing any fitness history or progress.

- Google account serves as the shared user identity.
- Google Photos serves as the shared photo library.
- Cloudflare D1 serves as the authoritative database for fitlogr records.
- Automatically synchronize meals, nutritional estimates, workouts, weight measurements, fitness goals, preferences, and historical progress.
- Allow users to capture meals on one device and review their progress on another.
- Allow users to switch between Apple and Android fitness ecosystems while retaining their historical data.
- Avoid duplicate records when multiple devices synchronize overlapping data.

## App Environment

The mobile application should be developed using a single cross-platform codebase supporting both iOS and Android.

| Component | Technology |
|---|---|
| Development IDE | Cursor |
| Mobile framework | React Native |
| Development platform | Expo |
| Programming language | TypeScript |
| Navigation | Expo Router |
| Authentication | Google Sign-In / OAuth 2.0 |
| Cloud photo storage | Google Photos |
| Photo integration | Google Photos APIs |
| Local photo access | Expo MediaLibrary / native integrations |
| Local database | Expo SQLite |
| Secure storage | Expo SecureStore |
| iOS health data | Apple HealthKit |
| Android health data | Health Connect |
| Development builds | Expo EAS |
| iOS beta distribution | Apple TestFlight |
| Android beta distribution | Google Play Internal Testing |
| Source control | GitHub |

### Development Requirements

- Support development on Windows without requiring a local Mac.
- Maintain a single codebase for iOS and Android.
- Use Expo Go for initial UI development and rapid prototyping.
- Use Expo development builds for native Google authentication, health integrations, and advanced permissions.
- Support Fast Refresh during development.
- Abstract platform-specific functionality behind shared interfaces.
- Test on physical iOS and Android devices throughout development.
- Minimize unnecessary third-party dependencies.

## Production Environment

The production website and backend API are served by Cloudflare Workers on fitlogr.com.

| Component | Configuration |
|---|---|
| Website | https://fitlogr.com |
| API | https://fitlogr.com/api/ |
| Hosting | Cloudflare Workers |
| Backend language | TypeScript |
| Deployment tool | Cloudflare Wrangler |
| Database | Cloudflare D1 |
| Photo storage | Google Photos |
| Temporary object storage | Cloudflare R2, if required |
| Background processing | Cloudflare Queues, if required |
| AI inference | Configurable multimodal AI provider |
| Authentication | Google OAuth 2.0 |
| DNS | Cloudflare |
| SSL/TLS | Cloudflare |
| CI/CD | GitHub Actions |

### Cloudflare Configuration

- Cloudflare Zone ID: `4da8c98a66722b963535773610a7d0d8`
- Cloudflare Account ID: `42aad73fe98811972eccd8907196d722`
- Cloudflare API Token: `CLOUDFLARE_API_TOKEN`

The Cloudflare API token is supplied through environment variables or GitHub Actions Secrets and must never be committed to the repository or embedded in the mobile application.

Use the existing Cloudflare account and zone when deploying production infrastructure. Reuse existing resources where appropriate.

### Google Cloud Configuration

Configure a Google Cloud project for fitlogr with the following services:

- Google OAuth 2.0
- Google Photos Picker API
- Google Photos Library API
- Google Health API, if required

Configure OAuth clients for:

- iOS application
- Android application
- Web application and backend

Environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_IOS_CLIENT_ID`
- `GOOGLE_ANDROID_CLIENT_ID`

Store confidential credentials securely using Cloudflare Worker Secrets or GitHub Actions Secrets, as appropriate.

## Proposed Repository Structure

```
fitlogr/
├── app/
│   ├── screens/
│   ├── components/
│   ├── services/
│   ├── hooks/
│   ├── assets/
│   └── app.json
├── worker/
│   ├── src/
│   │   ├── api/
│   │   ├── services/
│   │   └── index.ts
│   ├── public/
│   ├── migrations/
│   └── wrangler.toml
├── shared/
│   ├── types/
│   └── utilities/
├── docs/
├── .github/
│   └── workflows/
├── .gitignore
├── .env.example
└── README.md
```

## System Architecture

```
                 Google Account
                       │
              Google Photos Library
                 ▲           ▲
                 │           │
            Photo Backup  Photo Backup
                 │           │
          iPhone Photos    Android Photos
                 │           │
          Apple Health    Health Connect
                 │           │
          fitlogr (iOS)   fitlogr (Android)
                 │           │
                 └─────┬─────┘
                       │
                    HTTPS API
                       │
              Cloudflare Workers
                 fitlogr.com
                       │
                ┌──────┴──────┐
                │             │
          Cloudflare D1    AI Engine
          User Progress    Food Analysis
          Nutrition Data   Daily Insights
          Fitness Data
```

### Data Storage Principles

| Data | Storage |
|---|---|
| Original meal photos | Google Photos |
| User identity | Google account |
| User profile and preferences | Cloudflare D1 |
| Meal records | Cloudflare D1 |
| AI nutritional estimates | Cloudflare D1 |
| Workout records | Cloudflare D1 |
| Weight measurements | Cloudflare D1 |
| Historical progress | Cloudflare D1 |
| Synchronization checkpoints | Cloudflare D1 / local SQLite |
| Local application cache | Expo SQLite |
| Authentication tokens | SecureStore / secure backend storage |

Google Photos should be the primary persistent photo storage solution. Avoid maintaining a separate permanent copy of users' original photos on fitlogr infrastructure.

## AI Processing

AI should automate the most time-consuming aspects of fitness tracking.

The AI pipeline should:

1. Identify newly available, authorized photos.
2. Determine whether a photo contains food.
3. Detect duplicate photos of the same meal.
4. Identify individual food items.
5. Estimate portion sizes.
6. Estimate calories and macronutrients.
7. Assign the meal to the appropriate date and time.
8. Return structured nutritional data with confidence indicators.
9. Synchronize analysis results to the user's account.
10. Allow users to review and correct estimates.
11. Generate concise daily fitness summaries.

AI providers should be interchangeable through a common backend interface.

Prioritize inference accuracy, low latency, and low cost. Cache analysis results and avoid processing the same image more than once, including when accessed from different devices.

AI-generated nutritional information must be presented as an estimate rather than an exact measurement.

## Synchronization Strategy

### Photo Synchronization

- Require users to enable Google Photos automatic backup on their devices.
- Discover new meal photos through authorized local photo library access.
- Support importing existing cloud photos through Google Photos Picker.
- Use content hashes and image fingerprints to detect duplicate photos across devices.
- Store photo identifiers and nutritional analysis results in the central database.
- Avoid reprocessing photos that have already been analyzed.
- Do not rely on unrestricted background access to the Google Photos cloud library.
- Do not assume Google Photos provides a permanent direct URL for every photo.

### Health Synchronization

- Incrementally import health records from Apple Health and Health Connect.
- Maintain synchronization checkpoints for each device and data source.
- Normalize health records into a common cross-platform data format.
- Preserve source identifiers and timestamps.
- Prevent duplicate workouts, weight measurements, and calorie records.
- Avoid double-counting workout calories already included in daily activity totals.
- Synchronize normalized health data to the user's central account, subject to consent and platform policies.

### General Synchronization

- Automatically synchronize when the app opens.
- Use background synchronization where permitted by the operating system.
- Support offline operation and synchronize pending changes when connectivity is restored.
- Provide a manual synchronization option.
- Handle synchronization conflicts consistently.
- Use local time zones when calculating daily totals.
- Handle revoked permissions gracefully.
- Synchronize user corrections and preferences across all devices.

The user should not need to open fitlogr after every meal or workout.

## Data Privacy & Security

- Request only the Google, photo, and health permissions required for core functionality.
- Explain clearly why each permission is requested.
- Prefer on-device photo filtering before sending relevant meal photos for AI analysis.
- Never upload unrelated personal photos.
- Avoid permanently storing original meal photos on fitlogr infrastructure.
- Encrypt data in transit and at rest.
- Keep API credentials and infrastructure secrets on the server.
- Implement authentication, authorization, and API rate limiting.
- Ensure users can only access their own records.
- Allow users to export and permanently delete their fitlogr data.
- Do not delete original Google Photos content when deleting fitlogr records.
- Never sell personal health information or use it for targeted advertising.
- Do not use personal health data or photos for AI training without explicit consent and applicable platform authorization.
- Comply with applicable Google API user data policies, Apple App Store policies, and Google Play health data policies.

## Operating Cost Principles

fitlogr must remain financially sustainable while being offered for free.

- Prefer serverless infrastructure over dedicated servers.
- Leverage users' existing Google Photos storage.
- Minimize AI inference costs per user.
- Use lightweight models for food detection and more capable models for nutritional estimation when needed.
- Resize and compress images before transmission.
- Cache analysis results and eliminate duplicate processing across devices.
- Minimize storage and bandwidth requirements.
- Monitor infrastructure costs per active user.
- Implement safeguards against API abuse.
- Avoid architectural dependencies that create unnecessary recurring expenses.

## Development Guidelines

- Keep the application simple, fast, and intuitive.
- Prioritize automation over manual data entry.
- Write reusable, strongly typed, modular code.
- Maintain compatibility with both iOS and Android.
- Treat the backend as the authoritative source for synchronized fitness records.
- Treat Google Photos as the primary photo library.
- Document architectural decisions and external dependencies.
- Do not introduce paid services without evaluating their long-term operating costs.
- Do not hardcode credentials or API keys.
- Do not deploy breaking changes without testing.
- Maintain backward compatibility with previously released mobile applications.
- Keep this README updated as the project evolves.

## Mission

Make fitness tracking so effortless that anyone can do it, regardless of how busy their life is.

**Take photos. Wear your watch. Know your progress.**

https://fitlogr.com
