# fitlogr iPhone: automatic logging from Apple Photos and Apple Health

Implementation brief. Read all of it before changing code.

## Goal

After one guided setup, an iPhone user never has to open fitlogr for logging to happen. They take meal
photos with the regular Camera and wear their watch. fitlogr finds new photos, decides **on the phone**
which ones look like food, sends only those for analysis, logs the meals, and tells the user with a
notification, including when the day's calories are used up. Everything the app did with each photo
can be inspected in Settings.

## Decisions already made

Do not reopen these. If one turns out to be impossible, stop and report instead of substituting.

1. **Apple Photos and Apple Health only on iPhone.** Remove Google Photos from the iPhone app: the
   picker import, the album upload, and the "Reconnect Google Photos" UI.
2. **Sign-in stays Google, for identity only.** The iPhone app requests `openid email profile` and
   nothing else.
3. **Privacy first.** An on-device Apple Vision classifier is the first pass. A photo it rejects never
   leaves the phone, not even as a thumbnail or a hash.
4. **The classifier is conservative about discarding.** A photo is dropped on the phone only when the
   classifier is clearly confident it is unrelated. Anything ambiguous goes on to AI analysis. This is
   one policy value, so a stricter "send only confident food" stance is a one-line change.
5. **History import is automatic and resumable.** Default range 3 months; 12 months selectable.
6. **Three triggers run the same work:** opening the app, Apple Health background delivery, and an iOS
   background task.
7. **Notifications:** "meal logged" and "calories used up".
8. **Audit log** in Settings, selectable by day, with a thumbnail of every photo processed.
9. **Workout photos** (an exercise-machine console showing calories burned) are classified and shown
   in the audit log with their estimate. They do **not** change the day's burn yet, because Apple
   Health already reports the same workout for watch wearers.

## Starting point

- Work from `cursor/calorie-plan-5ee0` (head `ccef440`) on a new branch.
- **First merge `origin/cursor/ai-estimator-eval-28dd`.** It is unmerged work that changes the vision
  schema to `meal | workout | ignore` with `burn_kcal`, adds the structured prompt, and adds the
  58-photo benchmark. A trial merge had no conflicts, and typecheck plus all tests passed afterwards
  (96 shared, 60 worker). After the merge the server still treats anything that is not `meal` as a
  non-meal, so workouts are silently discarded; Phase 2 fixes that.
- Layout: `shared/` (zod schemas and pure logic), `worker/` (Cloudflare Worker, Hono, D1),
  `mobile/` (Expo SDK 58, expo-router, expo-sqlite). Commands from the repo root: `npm run typecheck`,
  `npm test`.
- The worker is live at `https://fitlogr.com/api` running this branch's code as of `adfb506`. Whether
  migrations `0003` and `0004` have been applied to production is not confirmed; ask David. **Do not
  deploy and do not run remote migrations.** New migrations start at `0005` and must be additive.
- Every change here needs a new native build. None of it can ship as an over-the-air update.
- **Nobody can run iOS in the cloud.** David builds with EAS and tests on his iPhone. That shapes the
  whole approach: see "How to work".

## Facts already verified in this codebase

These were checked against the code and the installed native sources. Rely on them.

- `expo-media-library`'s `Query…exeForMetadata()` returns `{ id, filename, creationTime (ms),
  mediaSubtypes }` cheaply. `asset.getInfo()` is expensive: it resolves the full-size original and
  downloads it from iCloud. `mobile/services/photos/library.ts` (`walkLibraryPhotos`,
  `prepareLibraryPhoto`, `libraryAccess`) already wraps the cheap path. Build on it.
- An asset id on iOS is `ph://<localIdentifier>`. `expo-image-manipulator` loads `ph://` ids directly
  at a requested size, fetching a small copy from iCloud if needed.
- iOS "Limited" photo access is reported as `granted: true` with `accessPrivileges: "limited"`.
  `libraryAccess()` returns `"limited"` for it. Automatic scanning needs `"full"`.
- `local_media_assets` (local SQLite, `mobile/services/db.ts`) has one row per photo the app handled.
  `alreadyChecked()` in `mobile/services/photos/upload.ts` treats every `scan_status` except `pending`
  and `error` as final. `importPreparedPhoto()` returns a structured `ImportResult.kind`, including
  `rate_limited` with `retryAfterSeconds`. Its `forceMeal` option re-analyses a photo the user chose
  deliberately.
- The server enforces a rolling vision limit (`PHOTO_LIMITS` in `shared/src/photos.ts`, currently 30
  per 5 minutes and 200 per day) and answers 429 with an accurate `Retry-After`.
- Server duplicate rules (`matchHash`): an exact SHA-256 match is always a duplicate; a perceptual
  match only counts within 15 minutes of capture.
- `@kingstinct/react-native-healthkit` 16.2 exposes `enableBackgroundDelivery(typeIdentifier,
  UpdateFrequency)` and `subscribeToChanges(identifier, callback)`. `UpdateFrequency` is
  `immediate = 1, hourly = 2, daily = 3`. Its config plugin registers launch-time observers itself, so
  no AppDelegate change is needed. `mobile/app.config.ts` currently passes `background: false`.
  `mobile/services/health/healthkit.ts` talks to the library through a hand-written `HealthKitApi`
  interface and a loose `require`, so TypeScript does not check those calls: read the real signatures
  in `node_modules/@kingstinct/react-native-healthkit/src/specs/CoreModule.nitro.ts` when extending it.
- Session tokens are in `expo-secure-store` with default accessibility (`mobile/services/session.ts`).
  That makes them unreadable while the phone is locked, which breaks background work.
- All orchestration (sync, scans, retries) lives inside the React component in
  `mobile/services/store.tsx`. Background launches need it outside React.
- `mobile/app.config.ts` uses `runtimeVersion: { policy: "appVersion" }`. Adding native modules without
  changing `version` would let an over-the-air update built for the new binary reach the old one.
- D1 allows 100 bound parameters per query. Chunk `IN (...)` lists and use `db.batch()`.
- Calories available is `remainingCalories(snapshot, eatenKcal, burnedKcal)` in
  `shared/src/caloriePlan.ts`, the same function the Log card uses.

## Architecture

### One engine, many triggers

Create a plain module (suggested `mobile/services/engine/`) that owns the work now done in
`store.tsx`: outbox sync, Apple Health sync, the photo pipeline, and notifications.

- One entry point, e.g. `runPass({ reason, budgetMs })`, with reasons `foreground`, `healthkit`,
  `background-task`, `setup`, `manual`.
- Single-flight: a second call while one is running joins or is dropped, never runs in parallel.
- A time budget checked between items. Foreground has no practical limit. Background passes must
  finish inside about 20 seconds and leave everything resumable.
- No React imports. It opens the database itself and emits events (progress, meal logged, state
  changed) that `StoreProvider` subscribes to.
- It must never show a permission prompt or any UI when the app is not active.
- `StoreProvider` becomes a thin subscriber. Its mount effect must not start foreground-only work when
  the app was launched in the background (check `AppState`).
- A pass does nothing in sample mode or when the session has expired (see `sessionExpired` in the
  store). It never signs the user out or clears local data.
- Apple Health history for the chosen range is imported automatically too: once after setup, in
  chunks, using the existing `syncHealthHistory`, and again when the range is extended.

### Photo pipeline

One pipeline covers "today's photos", "days I didn't open the app", and "history import". They differ
only in how far back the window goes.

1. **Discover.** Walk the library newest first from now back to `now − historyDays` using cheap
   metadata. Skip rows that already have a final state. Look up known ids in batches, not one query
   per photo.
2. **Classify on the phone.** Run the native classifier, compute a verdict with the shared policy, and
   write the row. A rejected photo is final here and is never sent anywhere.
3. **Queue.** Photos that pass are marked queued for analysis.
4. **Analyse.** Drain the queue **newest capture first**, so today's meal is never stuck behind three
   months of backlog. On 429, store a resume time and stop; do not sleep in a loop. In the foreground,
   schedule a timer to continue. Replace the `waitFor` loops in `history.ts`.
5. **Record.** Write the meal locally (existing `writeServerMeal`), keep a small persistent thumbnail
   for it, update the audit row, and hand new meals to the notification rules.

A photo the user takes or picks inside the app is always analysed (the existing `forceMeal`
behaviour). Still record its on-device labels, so the audit log shows what the filter would have done.

Classification of a whole range takes minutes; analysis drains at the server's pace. Report both:
"3,812 photos checked · 214 look like food · 180 analysed · 34 waiting".

The history range is a setting (`90` default, `365` selectable). Changing it only moves the window.
Retire `scanRecentPhotos` and `scanMealPhotosFromPastDays` in favour of the pipeline, and remove the
48-hour lookback and the 30-photo and 100-photo caps that only existed to bound those scans.

### Audit data

The pipeline's own table is the audit log. Extend `local_media_assets` (use the existing `addColumn`
migration pattern) rather than adding a parallel table. Each row needs at least:

- capture time and capture date (`YYYY-MM-DD`, device time zone, indexed), and source
  (`library | camera | picker`);
- on-device result: verdict, the top labels with confidences as JSON, classifier id and policy
  version, and when it ran;
- AI result: state (`not_sent | queued | meal | workout | ignore | duplicate | excluded | error`),
  classification, confidence, the estimate (name, kcal, macros, items, reason) as JSON, and when;
- links: `remote_photo_id`, `meal_id`, the persistent thumbnail path for meals, and the last error.

Keep the raw labels. When the policy version changes, verdicts can then be recomputed without
re-reading any photo, and rows that now pass can be queued.

Screenshots and unreadable photos get a row too (verdict `screenshot` / `unreadable`), so the log
really does show every photo processed. This table stays on the phone. It is not synced.

### On-device classifier

**Native module.** A local Expo module in `mobile/modules/` wrapping Apple's Vision framework
(`VNClassifyImageRequest`). Generate the skeleton with `npx create-expo-module@latest --local` so the
config matches SDK 58. Keep the Swift surface small:

- `classifyAssets(assetIds, { maxLabels, minConfidence })` returns, in order, either
  `{ assetId, labels: [{ id, confidence }] }` or `{ assetId, error }`. One bad asset must not fail the
  batch.
- `classifyFile(uri, …)` for camera and picker images.
- `supportedLabels()` returns the identifiers the classifier can emit on this iOS version.
- Load a small image (about 448 px) through `PHImageManager`. Try without network first, since iOS
  keeps small renditions locally; retry with network allowed only if that returns nothing. Work off
  the main thread and process a batch sequentially to bound memory.

**JS wrapper.** A `PhotoClassifier` interface (`id`, `available`, `classify`) with the Apple
implementation loaded through `requireOptionalNativeModule`. This is the seam for a different
classifier later. If the module is missing (Expo Go, Android), `available` is false and **automatic
scanning is off**; manual "add photo" still works. There is no fallback that uploads everything.

**Policy.** A pure function in `shared/` (suggested `shared/src/photoTriage.ts`) with tests:
`triage(labels, policy) → { verdict, matched }`, verdicts `food | workout | uncertain | not_relevant`.
The policy is data: a version string, a food label list, a workout label list, thresholds, and
`sendUncertain`. Starting values, to be tuned from real audit data:

- `food` when any food label is at or above 0.20;
- `workout` when any workout label (gym equipment, exercise machine, display or screen) is at or
  above 0.30;
- `uncertain` when any food or workout label is at or above 0.05, or the classifier's best label is
  below 0.30, or there are no labels;
- `not_relevant` otherwise.
- Sent for analysis: `food`, `workout`, and `uncertain` while `sendUncertain` is true (the default).

Apple's exact label identifiers are **not verified**. Match exact identifiers from a seed list, and
also fall back to a keyword match (food, meal, dish, fruit, vegetable, drink, beverage, dessert, and
similar) so an unexpected taxonomy still works. Show `supportedLabels()` in the audit diagnostics so
David can export the real list from his phone.

### Server changes

Keep them small and additive.

- **Classification and estimate in the analyse response.** Add `classification`
  (`meal | workout | ignore`) and `estimate` (from `estimateFromVision` in `shared/src/estimate.ts`,
  plus confidence) to `AnalyzePhotoResponse`. Keep `outcome` as it is for older builds; a workout
  reports `outcome: "not_meal"`.
- **Persist it.** Migration `0005`: add `ai_classification` and `ai_estimate_json` to `photos`. The
  `status` CHECK constraint cannot take a new value without rebuilding the table, so store a workout
  photo as `analyzed_non_meal` with `ai_classification = 'workout'`.
- **Album upload becomes opt-in per request.** Add an optional flag to the analyse metadata. The
  server uploads to Google Photos only when the flag is true and the stored token has a Photos scope.
  When the flag is absent keep today's behaviour, so the build currently on David's phone keeps
  working. The new iPhone app sends false. Leave the Google Photos modules and routes in place and
  unused.
- **Basic sign-in scopes.** Add an optional flag to `AuthStartRequestSchema`. When false, request
  only `openid email profile`. Absent means today's scopes.
- **Limits as configuration.** Let worker environment variables override the vision limits, with
  defaults of 40 per 5 minutes and 400 per day. Only photos that passed the on-device filter count
  now. The app follows `Retry-After`, so it needs no matching change.
- **Optional:** accept the on-device verdict and top labels in the analyse metadata and store them on
  the photo row, so filter precision can be measured later. Only for photos that were sent anyway.

### Notifications

Local notifications through `expo-notifications`. No push server.

Put the rules in a pure, tested function: given the meals a pass just logged and the day's state, it
returns the notifications to post.

- **Meal logged.** For meals captured in roughly the last 18 hours, one notification per pass:
  "Lunch logged · 640 kcal. 310 kcal available today." Several meals collapse into one summary. Never
  for history backfill. Not while the app is in the foreground.
- **Calories used up.** When today's calories available reach zero or below because of a newly
  logged meal, once per local day: "You've used today's calories: 2,140 eaten, 2,050 available."
  In the foreground show it in the app instead.
- Extract the calories-available calculation the Log card uses into one shared helper and call it
  from both places, so the alert and the card cannot disagree.
- Tapping a notification opens the Log on that day.
- Two toggles in Settings, both on by default once permission is granted.

### Background triggers

- **Apple Health background delivery.** Set `background: true` for the HealthKit plugin. At module
  scope, in a file imported by `mobile/app/_layout.tsx` so it runs on a headless launch, enable
  background delivery and subscribe to changes: active energy and steps hourly, workouts and body
  mass immediate. The callback runs `runPass({ reason: "healthkit" })`. Never request authorization
  from this path.
- **iOS background task.** Add `expo-background-task` (with `expo-task-manager`), define the task at
  module scope, register it once setup is complete, and run the same pass.
- **Keychain.** Store the session and device id with
  `keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK`, and rewrite existing values once in the
  foreground so installed sessions migrate.
- Apple Health data and the photo library can be unreadable while the phone is locked. Treat that as
  "try again next pass", never as an error state the user sees.
- **Background activity log.** Keep the last 50 passes locally: time, trigger, duration, counts, and
  any error. Show it in the audit diagnostics. This is the only way anyone can tell whether iOS is
  actually waking the app.

### Guided setup

One flow shown on first launch and reachable later from Settings as "Finish setup". Each step
explains why in one sentence, can be skipped, and re-checks its state when the app returns from iOS
Settings.

1. Sign in with Google. "Look around first" keeps the existing sample mode.
2. Photos: the analysis consent (reuse `acceptPhotoConsent`; the copy now says only photos that look
   like food are sent) and then full photo access. If the user picks Limited, explain and link to iOS
   Settings.
3. Apple Health.
4. Notifications.
5. History range: 3 months selected, 12 months available.
6. Done: start the pipeline and show its progress.

The banners in `MealPhotoPicker` and the setup rows in `ImportHistoryCard` remain only as recovery
when a permission is later revoked. Replace the "Import Apple Photos" and "Import Apple Health"
buttons with status and progress for the automatic import, plus the range selector.

### Audit UI

Settings → My Data → "Photo log".

- **Day list**, newest first, each day with counts: "42 photos · 6 looked like food · 5 meals ·
  1 workout". A day is the capture date.
- **Day view:** every photo for that day. Each row shows a thumbnail, capture time, the on-device
  verdict with its top labels and confidences, the AI classification (`meal`, `workout`, `none`, or
  "not sent"), and the AI estimate (name, kcal, macros). Filter chips: All, Sent to AI, Meals, Kept on
  phone.
- **Row detail:** larger image, all labels, the estimate's items and reason, timestamps, any error,
  and actions: "Analyse anyway" (the existing `forceMeal` path), "Not a meal" (the existing exclude
  path), and "Open meal".
- **Diagnostics** at the bottom: classifier id and policy version, pipeline totals, the background
  activity log, and "Export labels".
- **Thumbnails** render from the library by asset id; add `expo-image` and confirm in its native
  source that it loads `ph://` ids before relying on it. If the photo was deleted from the library,
  show a placeholder. Do not keep copies of photos that were rejected on the phone.

### Remove Google Photos from the iPhone app

- Delete `mobile/services/photos/picker.ts`, the Google rows and buttons in `ImportHistoryCard`,
  `grantPickerAccess`, `retryAlbumUploads` and `google_pending`, the Google Photos variant of the
  reconnect banner, and the `google_status` polling in the store. Keep the "Sign in again" banner for
  expired sessions.
- `MealPhoto` shows the photo from the phone: the persistent meal thumbnail first, then the library
  asset. Keep the existing `/photos/:id/url` request as a last fallback so meals already stored in
  Google Photos still show.
- Update the copy that promises Google Photos storage: `worker/public/privacy/index.html`,
  `README.md` (product principles and account requirements), `DESIGN.md`, and the usage strings in
  `mobile/app.config.ts`.

## Phases

Commit each phase separately, with typecheck and tests green.

| Phase | Contents | Done when |
|---|---|---|
| 0 | Merge the estimator branch. Bump the app `version`. | Typecheck and tests pass. |
| 1 | Remove Google Photos from the app; server opt-in flags; basic scopes. | A new sign-in asks only for name and email. A meal logs with no Google Photos call. Old-build behaviour is unchanged when the flags are absent (tested). |
| 2 | Server: classification, estimate, migration `0005`, configurable limits. | Worker tests cover meal, workout, and ignore responses. |
| 3 | Engine extraction and the photo pipeline with the audit table, using a stub classifier that passes everything. | Pipeline tests pass: newest first, resume after 429, already-final rows untouched, a bad photo does not stop a pass. |
| 4 | Native classifier module, wrapper, and shared policy. | Policy tests pass. The app typechecks and behaves sensibly when the module is absent. |
| 5 | Notifications and the calories-used-up alert. | Rule tests pass, including once-per-day and no backfill notifications. |
| 6 | Apple Health background delivery, background task, keychain change, activity log. | A simulated background pass respects the time budget in tests. |
| 7 | Guided setup and the audit UI. | Screens typecheck; states for denied, limited, and missing module are handled. |

## How to work

- **Put logic where it can be tested.** Policy, pipeline ordering, pacing, and notification rules go
  in pure modules. `mobile/` has no test runner yet: add vitest to it and stub `expo-media-library`,
  `expo-constants`, and the native classifier through aliases. A scratch harness built that way
  already validated the current scan logic.
- **Native code cannot be compiled here.** Keep the Swift minimal, follow the generated module
  skeleton exactly, and make the JS tolerant of the module being absent or throwing.
- Use `npx expo install` for every new native dependency so versions match SDK 58, then run
  `npx expo-doctor`.
- Match the existing code: small focused modules, comments that explain why, plain user-facing copy.
- Do not delete server routes, tables, or migrations. Do not change what `outcome` means.
- Do not add Android work. Keep the existing `HealthConnectProvider` stub compiling.
- If Apple's label names, an Expo API, or an entitlement behaves differently from this brief, follow
  what the installed source shows and record the difference.

## Report back

End with a summary for David containing:

1. What was built per phase, and anything skipped or changed from this brief, with the reason.
2. New native dependencies, the new app version, and any Apple Developer portal step needed (for
   example the HealthKit background delivery capability).
3. Server steps for David: migrations to apply, new environment variables, and the deploy order
   relative to the app build.
4. A device test checklist in order: setup flow; a new meal photo logged on open; the same with the
   app closed, waiting for an Apple Health wake; history import progress; the audit log for today;
   the calories-used-up alert; Limited access recovery; behaviour after a phone restart before first
   unlock.
5. What could not be verified without a device, stated plainly.
