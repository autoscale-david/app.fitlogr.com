import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import { AI_PHOTO_CONSENT_VERSION, type DailyInsight, type TrendsResponse } from "@fitlogr/shared";
import { api, SessionExpired } from "./api";
import { getHealthProvider, readHealthConnection, syncAppleHealth, syncHealthHistory, type HealthConnection } from "./health";
import { AuthCancelled, signInWithGoogle } from "./auth";
import {
  enterAccountMode,
  enterDemoMode,
  listWeights,
  loadDay,
  loadWeekStatus,
  localMealPhoto,
  loggedDates,
  openFitlogrDatabase,
  pendingChanges,
  readAccount,
  readGoals,
  readMeal,
  readMode,
  readSetting,
  removeMeal,
  restoreSample,
  sealPlanSnapshots,
  writeAccount,
  writeGoals,
  writeMeal,
  writeSetting,
  writeWeightKg,
  type DataMode,
  type DayLog,
  type Goals,
  type MealRecord,
  type WeekDayStatus,
} from "./db";
import { clearSession, migrateKeychain, readSession, saveSession } from "./session";
import { shareAccountExport } from "./exportAccount";
import {
  capturedToday,
  importPreparedPhoto,
  prepareMealImage,
  retryPendingPhotos,
  type HistoryProgress,
  type HistoryScanResult,
  type LibraryAccess,
} from "./photos";
import { decideLabels, getClassifier } from "./engine/classifier";
import { armHealthWake } from "./engine/background";
import { subscribeEngine, runPass } from "./engine/runPass";
import { recordImport } from "./engine/photoPass";
import { queueMeal, queueMealDelete, queuePhotoExclude, queueSettings, queueWeight, syncAccount } from "./sync";

interface Account {
  email: string;
  displayName: string | null;
}

/** State of the automatic camera-roll scan, for the Log screen. */
export interface PhotoScanState {
  /** True while new photos are being analyzed. */
  active: boolean;
  /** Result worth showing after an automatic scan: meals found, limited access, or the analysis limit. */
  message: string | null;
  /** Photo-library access as of the last scan; null until one has run (or in Expo Go). */
  access: LibraryAccess | null;
}

interface Store {
  ready: boolean;
  goals: Goals | null;
  refreshToken: number;
  mode: DataMode;
  account: Account | null;
  syncing: boolean;
  pending: number;
  syncError: string | null;
  photoConsent: boolean;
  health: HealthConnection | null;
  /** Signed-in data is still on this phone, but the session ended; sign in again to resume syncing. */
  sessionExpired: boolean;
  photoScan: PhotoScanState;
  calorieNotice: string | null;
  dismissCalorieNotice: () => void;
  lastSyncedAt: string | null;
  loadDay: (date: string) => Promise<DayLog>;
  loadWeek: (from: string, to: string) => Promise<Record<string, WeekDayStatus>>;
  readLocal: (key: string) => Promise<string | null>;
  writeLocal: (key: string, value: string) => Promise<void>;
  listWeights: (from: string, to: string) => Promise<{ localDate: string; weightKg: number }[]>;
  loadInsight: (date: string) => Promise<DailyInsight | null>;
  loadTrends: (days: 7 | 14 | 30) => Promise<TrendsResponse | null>;
  localMealPhoto: (photoId: string) => Promise<{ thumbUri: string | null; fileUri: string | null; libraryId: string | null } | null>;
  exportAccount: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  loggedDates: () => Promise<string[]>;
  saveGoals: (goals: Goals) => Promise<void>;
  restoreSample: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  sync: (force?: boolean) => Promise<void>;
  syncHealth: () => Promise<HealthConnection | null>;
  readMeal: (id: string) => Promise<(MealRecord & { pendingCreate: boolean }) | null>;
  saveMeal: (meal: MealRecord, pendingCreate: boolean) => Promise<void>;
  deleteMeal: (id: string, pendingCreate: boolean, photoId?: string | null) => Promise<void>;
  logWeight: (localDate: string, weightKg: number) => Promise<void>;
  acceptPhotoConsent: () => Promise<void>;
  addMealPhoto: (uri: string, captured?: { capturedAt: string; localDate: string }) => Promise<string>;
  /** Returns "" when nothing new turned up, unless `announceEmpty` asks for that message too. */
  scanMealPhotos: (announceEmpty?: boolean) => Promise<string>;
  scanHistory: (days: number, onProgress: (progress: HistoryProgress) => void, signal: AbortSignal) => Promise<HistoryScanResult>;
  importHealthHistory: (days: number) => Promise<{ message: string; total: number; workouts: number }>;
}

const StoreContext = createContext<Store | null>(null);
let syncChain: Promise<void> = Promise.resolve();

export function StoreProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<SQLiteDatabase | null>(null);
  const [goals, setGoals] = useState<Goals | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [mode, setMode] = useState<DataMode>("demo");
  const [account, setAccount] = useState<Account | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [photoConsent, setPhotoConsent] = useState(false);
  const [health, setHealth] = useState<HealthConnection | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [photoScan, setPhotoScan] = useState<PhotoScanState>({ active: false, message: null, access: null });
  const [calorieNotice, setCalorieNotice] = useState<string | null>(null);

  /**
   * Stores a new session. Re-signing into the account already on this phone keeps its data and queued
   * changes; only a different account (or leaving the sample preview) starts from an empty log.
   */
  async function adoptSession(database: SQLiteDatabase, session: Awaited<ReturnType<typeof signInWithGoogle>>) {
    await saveSession(session);
    const current = await readAccount(database);
    const sameAccount = (await readMode(database)) === "account" && current?.email === session.user.email;
    if (!sameAccount) {
      await enterAccountMode(database);
      if ((await readSetting(database, "ai_photo_consent_version")) === AI_PHOTO_CONSENT_VERSION) {
        await writeSetting(database, "ai_photo_consent_pending", "1");
        setPhotoConsent(true);
      }
    }
    await writeAccount(database, session.user.email, session.user.display_name);
    setMode("account");
    setAccount({ email: session.user.email, displayName: session.user.display_name });
    setSessionExpired(false);
    setSyncError(null);
    setGoals(await readGoals(database));
  }

  async function refreshPending(database: SQLiteDatabase) {
    setPending(await pendingChanges(database));
  }

  async function runSync(database: SQLiteDatabase, force = false) {
    const currentMode = (await readSetting(database, "data_mode")) === "account" ? "account" : "demo";
    if (currentMode !== "account") {
      setHealth(await readHealthConnection(database));
      setRefreshToken((token) => token + 1);
      return;
    }
    if (!(await readSession()).refreshToken) {
      // Session ended earlier: nothing can sync until the person signs in again.
      setSessionExpired(true);
      setRefreshToken((token) => token + 1);
      return;
    }
    setSyncing(true);
    try {
      let rejected = (await syncAccount(database, force)).rejected;
      await retryPendingPhotos(database);
      let healthError: string | null = null;
      try {
        await syncAppleHealth(database, { force, upload: true });
        rejected += (await syncAccount(database, true)).rejected;
      } catch (error) {
        if (error instanceof SessionExpired) throw error;
        healthError = error instanceof Error ? error.message : "Apple Health sync failed";
      }
      setGoals(await readGoals(database));
      setHealth(await readHealthConnection(database));
      setSessionExpired(false);
      const rejectedNote = rejected > 0 ? `${rejected} change${rejected === 1 ? " was" : "s were"} rejected by fitlogr.com and not saved there.` : null;
      setSyncError(healthError ?? rejectedNote);
      const stamp = new Date().toISOString();
      await writeSetting(database, "last_synced_at", stamp);
      setLastSyncedAt(stamp);
      setRefreshToken((token) => token + 1);
    } catch (error) {
      if (error instanceof SessionExpired) {
        // Keep the log and any unsynced changes on the phone. They sync after the person signs in again.
        await clearSession();
        setSessionExpired(true);
        setSyncError("Your session ended. Sign in again to keep syncing. Everything on this phone is kept.");
        setRefreshToken((token) => token + 1);
      } else {
        setSyncError(error instanceof Error ? error.message : "Sync failed");
      }
    } finally {
      setSyncing(false);
      await refreshPending(database);
    }
  }

  function sync(database: SQLiteDatabase, force = false) {
    const run = syncChain.then(() => runSync(database, force));
    syncChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  useEffect(() => {
    let cancelled = false;
    openFitlogrDatabase()
      .then(async (database) => {
        if (AppState.currentState === "active") await migrateKeychain();
        const session = await readSession();
        let nextMode = await readMode(database);
        if (session.refreshToken && nextMode !== "account") {
          await enterAccountMode(database);
          nextMode = "account";
        }
        // Account data without a session means the session ended. Keep the data and ask to sign in.
        const expired = !session.refreshToken && nextMode === "account";
        const nextGoals = await readGoals(database);
        const nextAccount = nextMode === "account" ? await readAccount(database) : null;
        const nextConsent = (await readSetting(database, "ai_photo_consent_version")) === AI_PHOTO_CONSENT_VERSION;
        if (!cancelled) {
          setDb(database);
          setGoals(nextGoals);
          setMode(nextMode);
          setAccount(nextAccount);
          setPhotoConsent(nextConsent);
          setPending(await pendingChanges(database));
          setHealth(await readHealthConnection(database));
          const syncedAt = await readSetting(database, "last_synced_at");
          setLastSyncedAt(syncedAt || null);
          setSessionExpired(expired);
          if (expired) setSyncError("Your session ended. Sign in again to keep syncing. Everything on this phone is kept.");
        }
        if (!cancelled && session.refreshToken && AppState.currentState === "active") {
          await runPass({ reason: "foreground", active: true });
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to open fitlogr database", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!db) return;
    const unsubscribe = subscribeEngine((event) => {
      if (event.type === "meal" || event.type === "state") {
        setRefreshToken((token) => token + 1);
        void refreshPending(db);
        void readGoals(db).then(setGoals);
        void readHealthConnection(db).then(setHealth);
      }
      if (event.type === "state") {
        void readSetting(db, "last_synced_at").then((stamp) => setLastSyncedAt(stamp || null));
      }
      if (event.type === "progress") {
        setPhotoScan((current) => ({ ...current, active: event.running, message: event.message || current.message }));
      }
      if (event.type === "alert") setCalorieNotice(event.body);
      if (event.type === "session-expired") {
        // Same as a sync that hits an expired session: keep everything on the phone and ask to sign in.
        void clearSession().then(() => {
          setSessionExpired(true);
          setSyncError("Your session ended. Sign in again to keep syncing. Everything on this phone is kept.");
          setRefreshToken((token) => token + 1);
        });
      }
    });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void runPass({ reason: "foreground", active: true });
    });
    return () => {
      unsubscribe();
      subscription.remove();
    };
  }, [db]);

  const value = useMemo<Store>(
    () => ({
      ready: db !== null && goals !== null,
      goals,
      refreshToken,
      mode,
      account,
      syncing,
      pending,
      syncError,
      photoConsent,
      health,
      sessionExpired,
      photoScan,
      calorieNotice,
      dismissCalorieNotice: () => setCalorieNotice(null),
      lastSyncedAt,
      loadDay: (date) => {
        if (!db) throw new Error("Database is not open");
        return loadDay(db, date);
      },
      loadWeek: async (from, to) => {
        if (!db) throw new Error("Database is not open");
        if (goals) await sealPlanSnapshots(db, goals);
        return loadWeekStatus(db, from, to);
      },
      readLocal: (key) => {
        if (!db) return Promise.resolve(null);
        return readSetting(db, key);
      },
      writeLocal: async (key, value) => {
        if (!db) return;
        await writeSetting(db, key, value);
      },
      loggedDates: () => {
        if (!db) throw new Error("Database is not open");
        return loggedDates(db);
      },
      listWeights: (from, to) => {
        if (!db) throw new Error("Database is not open");
        return listWeights(db, from, to);
      },
      loadInsight: async (date) => {
        if (!db || mode !== "account") return null;
        try {
          const body = await api.send<DailyInsight>("GET", `/insights/${date}`);
          await writeSetting(db, "insight_cache", JSON.stringify(body));
          return body;
        } catch {
          const raw = await readSetting(db, "insight_cache");
          if (!raw) return null;
          try {
            const cached = JSON.parse(raw) as DailyInsight;
            if (cached.date !== date) return null;
            return { ...cached, cached: true };
          } catch {
            return null;
          }
        }
      },
      loadTrends: async (days) => {
        if (mode !== "account") return null;
        try {
          return await api.send<TrendsResponse>("GET", `/review/trends?days=${days}`);
        } catch {
          return null;
        }
      },
      localMealPhoto: (photoId) => {
        if (!db) return Promise.resolve(null);
        return localMealPhoto(db, photoId);
      },
      exportAccount: async () => {
        if (mode !== "account") throw new Error("Sign in to export your fitlogr data");
        const data = await api.send<unknown>("GET", "/account/export");
        await shareAccountExport(JSON.stringify(data, null, 2));
      },
      deleteAccount: async () => {
        if (!db || mode !== "account") return;
        await api.send("DELETE", "/account", { confirm: true });
        await clearSession();
        await enterDemoMode(db);
        await writeSetting(db, "last_synced_at", "");
        await writeSetting(db, "insight_cache", "");
        setMode("demo");
        setAccount(null);
        setSessionExpired(false);
        setLastSyncedAt(null);
        setSyncError(null);
        setPending(0);
        setGoals(await readGoals(db));
        setRefreshToken((token) => token + 1);
      },
      saveGoals: async (next) => {
        if (!db) return;
        await writeGoals(db, next);
        setGoals(next);
        if (mode === "account") {
          await queueSettings(db, next);
          await refreshPending(db);
          void sync(db, true);
        }
        setRefreshToken((token) => token + 1);
      },
      restoreSample: async () => {
        if (!db || mode === "account") return;
        await restoreSample(db);
        setGoals(await readGoals(db));
        setRefreshToken((token) => token + 1);
      },
      signIn: async () => {
        if (!db) return;
        await adoptSession(db, await signInWithGoogle());
        await sync(db, true);
      },
      signOut: async () => {
        if (!db) return;
        try {
          await api.logout();
        } catch {
          // Local sign-out still clears the phone if the network is down.
        }
        await clearSession();
        await enterDemoMode(db);
        await writeSetting(db, "last_synced_at", "");
        setMode("demo");
        setAccount(null);
        setSessionExpired(false);
        setLastSyncedAt(null);
        setSyncError(null);
        setGoals(await readGoals(db));
        setPending(0);
        setRefreshToken((token) => token + 1);
      },
      sync: (force = false) => {
        if (!db) return Promise.resolve();
        return sync(db, force);
      },
      syncHealth: async () => {
        if (!db) return null;
        try {
          const provider = getHealthProvider();
          if (provider.id === "healthkit" && (await provider.getPermissionState()) !== "authorized") {
            await provider.requestPermissions();
            // Background delivery only starts for observers registered after access is granted.
            armHealthWake();
          }
        } catch (error) {
          setSyncError(error instanceof Error ? error.message : "Apple Health sync failed");
          const connection = await readHealthConnection(db);
          setHealth(connection);
          return connection;
        }
        if (mode !== "account") {
          const connection = await readHealthConnection(db);
          setHealth(connection);
          return connection;
        }
        await sync(db, true);
        return readHealthConnection(db);
      },
      readMeal: (id) => {
        if (!db) throw new Error("Database is not open");
        return readMeal(db, id);
      },
      saveMeal: async (meal, pendingCreate) => {
        if (!db) return;
        await writeMeal(db, meal, mode === "account" && pendingCreate);
        if (mode === "account") {
          await queueMeal(db, meal, pendingCreate);
          await refreshPending(db);
          void sync(db, true);
        }
        setRefreshToken((token) => token + 1);
      },
      deleteMeal: async (id, pendingCreate, photoId) => {
        if (!db) return;
        await removeMeal(db, id);
        if (mode === "account") {
          if (photoId) await queuePhotoExclude(db, photoId);
          else await queueMealDelete(db, id, pendingCreate);
          await refreshPending(db);
          void sync(db, true);
        }
        setRefreshToken((token) => token + 1);
      },
      acceptPhotoConsent: async () => {
        if (!db) return;
        await writeSetting(db, "ai_photo_consent_version", AI_PHOTO_CONSENT_VERSION);
        await writeSetting(db, "ai_photo_consent_at", new Date().toISOString());
        setPhotoConsent(true);
        if (mode !== "account") return;
        try {
          await api.send("PUT", "/settings", { accept_ai_consent: true, ai_consent_version: AI_PHOTO_CONSENT_VERSION });
          await writeSetting(db, "ai_photo_consent_pending", "0");
        } catch {
          await writeSetting(db, "ai_photo_consent_pending", "1");
        }
        setRefreshToken((token) => token + 1);
        if (AppState.currentState === "active") void runPass({ reason: "foreground", active: true });
      },
      addMealPhoto: async (uri, captured) => {
        if (!db || mode !== "account") return "Sign in with Google before analyzing a meal photo.";
        const prepared = await prepareMealImage(uri);
        const when = captured ?? capturedToday();
        const classifier = getClassifier();
        let onDeviceVerdict: string | undefined;
        let onDeviceLabels: { id: string; confidence: number }[] | undefined;
        if (classifier.available) {
          const classified = await classifier.classifyFile(prepared.uri);
          if (!("error" in classified)) {
            onDeviceLabels = classified.labels;
            onDeviceVerdict = decideLabels(classified.labels).verdict;
          }
        }
        const result = await importPreparedPhoto(db, prepared, {
          ...when,
          source: "manual",
          forceMeal: true,
          onDeviceVerdict,
          onDeviceLabels,
        });
        // A photo added by hand appears in the photo log too, with what the on-device check said about it.
        await recordImport(db, {
          assetId: prepared.sha256,
          capturedAtMs: Date.parse(when.capturedAt) || Date.now(),
          source: "picker",
          verdict: onDeviceVerdict ?? null,
          labels: onDeviceLabels,
          preparedUri: prepared.uri,
          result,
        }).catch(() => undefined);
        // The meal is already in the local log. Refresh before sync so a picker blur cannot skip the update.
        setRefreshToken((token) => token + 1);
        try {
          await sync(db, true);
        } finally {
          setRefreshToken((token) => token + 1);
        }
        return result.message;
      },
      scanHistory: async (days, onProgress, signal) => {
        if (!db || mode !== "account") {
          return {
            status: "unavailable",
            capped: false,
            scanned: 0,
            skipped: 0,
            meals: 0,
            nonMeals: 0,
            errors: 0,
            message: "Sign in with Google before importing history.",
          };
        }
        // Through the engine, so it can never run alongside another pass over the same photos.
        await writeSetting(db, "photo_history_days", String(days));
        setPhotoScan((current) => ({ ...current, active: true }));
        let pass: Awaited<ReturnType<typeof runPass>>;
        try {
          pass = await runPass({ reason: "manual", active: true, historyDays: days, signal });
        } catch (error) {
          setPhotoScan((current) => ({ ...current, active: false }));
          throw error;
        }
        const result = pass.photos;
        setRefreshToken((token) => token + 1);
        if (!result) {
          setPhotoScan((current) => ({ ...current, active: false }));
          return {
            status: "unavailable",
            capped: false,
            scanned: 0,
            skipped: 0,
            meals: 0,
            nonMeals: 0,
            errors: 0,
            message: pass.error === "session" ? "Sign in again to keep importing photos." : "Agree to photo analysis first.",
          };
        }
        const counts = result.counts;
        onProgress({ scanned: counts.checked, skipped: 0, meals: counts.meals, nonMeals: Math.max(0, counts.analysed - counts.meals), errors: counts.errors });
        setPhotoScan({ active: false, message: result.message, access: result.access });
        return {
          status: result.access === "denied" || result.access === "undetermined" ? "permission_denied" : signal.aborted ? "cancelled" : "imported",
          capped: result.stoppedForBudget,
          scanned: counts.checked,
          skipped: 0,
          meals: counts.meals,
          nonMeals: Math.max(0, counts.analysed - counts.meals),
          errors: counts.errors,
          message: result.message,
        };
      },
      importHealthHistory: async (days) => {
        if (!db || mode !== "account") return { message: "Sign in with Google before importing Apple Health.", total: 0, workouts: 0 };
        const result = await syncHealthHistory(db, days);
        setRefreshToken((token) => token + 1);
        return { message: result.message, total: result.records, workouts: result.workouts };
      },
      scanMealPhotos: async (announceEmpty = false) => {
        if (!db || mode !== "account" || !photoConsent) return "";
        if (sessionExpired) return announceEmpty ? "Sign in again to keep importing meal photos." : "";
        setPhotoScan((current) => ({ ...current, active: true, message: null }));
        let result: Awaited<ReturnType<typeof runPass>>;
        try {
          result = await runPass({ reason: "manual", active: AppState.currentState === "active" });
        } catch (error) {
          setPhotoScan((current) => ({ ...current, active: false }));
          throw error;
        }
        const message = result.photos?.message ?? "";
        setPhotoScan({ active: false, message: message || null, access: result.photos?.access ?? null });
        return !message || (!announceEmpty && (result.photos?.counts.meals ?? 0) === 0) ? "" : message;
      },
      logWeight: async (localDate, weightKg) => {
        if (!db) return;
        await writeWeightKg(db, localDate, weightKg);
        if (mode === "account") {
          await queueWeight(db, localDate, weightKg);
          await refreshPending(db);
          void sync(db, true);
        }
        setRefreshToken((token) => token + 1);
      },
    }),
    [account, calorieNotice, db, goals, health, lastSyncedAt, mode, pending, photoConsent, photoScan, refreshToken, sessionExpired, syncError, syncing],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside StoreProvider");
  return store;
}

export { AuthCancelled };
