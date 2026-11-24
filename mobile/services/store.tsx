import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { AI_PHOTO_CONSENT_VERSION, type DailyInsight, type TrendsResponse } from "@fitlogr/shared";
import { api, ApiError, SessionExpired } from "./api";
import { getHealthProvider, readHealthConnection, syncAppleHealth, type HealthConnection } from "./health";
import { AuthCancelled, signInWithGoogle } from "./auth";
import {
  enterAccountMode,
  enterDemoMode,
  listWeights,
  loadDay,
  loggedDates,
  migrate,
  pendingChanges,
  readAccount,
  readGoals,
  readMeal,
  readMode,
  readSetting,
  removeMeal,
  restoreSample,
  writeAccount,
  writeGoals,
  writeMeal,
  writeSetting,
  writeWeightKg,
  type DataMode,
  type DayLog,
  type Goals,
  type MealRecord,
} from "./db";
import { clearSession, readSession, saveSession } from "./session";
import { shareAccountExport } from "./exportAccount";
import { capturedToday, importPreparedPhoto, prepareMealImage, retryPendingPhotos, scanRecentPhotos } from "./photos";
import { queueMeal, queueMealDelete, queuePhotoExclude, queueSettings, queueWeight, syncAccount } from "./sync";

interface Account {
  email: string;
  displayName: string | null;
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
  googleReconnectRequired: boolean;
  lastSyncedAt: string | null;
  loadDay: (date: string) => Promise<DayLog>;
  listWeights: (from: string, to: string) => Promise<{ localDate: string; weightKg: number }[]>;
  loadInsight: (date: string) => Promise<DailyInsight | null>;
  loadTrends: (days: 7 | 14 | 30) => Promise<TrendsResponse | null>;
  reconnectGoogle: () => Promise<void>;
  exportAccount: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  loggedDates: () => Promise<string[]>;
  saveGoals: (goals: Goals) => Promise<void>;
  restoreSample: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  sync: (force?: boolean) => Promise<void>;
  syncHealth: () => Promise<void>;
  readMeal: (id: string) => Promise<(MealRecord & { pendingCreate: boolean }) | null>;
  saveMeal: (meal: MealRecord, pendingCreate: boolean) => Promise<void>;
  deleteMeal: (id: string, pendingCreate: boolean, photoId?: string | null) => Promise<void>;
  logWeight: (localDate: string, weightKg: number) => Promise<void>;
  acceptPhotoConsent: () => Promise<void>;
  addMealPhoto: (uri: string) => Promise<string>;
  scanMealPhotos: () => Promise<string>;
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
  const [googleReconnectRequired, setGoogleReconnectRequired] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

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
    setSyncing(true);
    try {
      await syncAccount(database, force);
      await retryPendingPhotos(database);
      let healthError: string | null = null;
      try {
        await syncAppleHealth(database, { force, upload: true });
        await syncAccount(database, true);
      } catch (error) {
        if (error instanceof SessionExpired) throw error;
        healthError = error instanceof Error ? error.message : "Apple Health sync failed";
      }
      setGoals(await readGoals(database));
      setHealth(await readHealthConnection(database));
      setSyncError(healthError);
      const stamp = new Date().toISOString();
      await writeSetting(database, "last_synced_at", stamp);
      setLastSyncedAt(stamp);
      try {
        const me = await api.me();
        const reconnect = me.google.status === "revoked" || me.google.status === "error";
        await writeSetting(database, "google_status", me.google.status);
        setGoogleReconnectRequired(reconnect);
      } catch (error) {
        if (error instanceof ApiError && error.code === "google_reconnect_required") {
          await writeSetting(database, "google_status", "revoked");
          setGoogleReconnectRequired(true);
        }
      }
      setRefreshToken((token) => token + 1);
    } catch (error) {
      if (error instanceof ApiError && error.code === "google_reconnect_required") {
        await writeSetting(database, "google_status", "revoked");
        setGoogleReconnectRequired(true);
      }
      if (error instanceof SessionExpired) {
        await clearSession();
        await enterDemoMode(database);
        setMode("demo");
        setAccount(null);
        setGoals(await readGoals(database));
        setSyncError("Sign in again");
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
    openDatabaseAsync("fitlogr.db")
      .then(async (database) => {
        await migrate(database);
        const session = await readSession();
        let nextMode = await readMode(database);
        if (session.refreshToken && nextMode !== "account") {
          await enterAccountMode(database);
          nextMode = "account";
        }
        if (!session.refreshToken && nextMode === "account") {
          await enterDemoMode(database);
          nextMode = "demo";
        }
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
          const googleStatus = await readSetting(database, "google_status");
          setLastSyncedAt(syncedAt || null);
          setGoogleReconnectRequired(googleStatus === "revoked" || googleStatus === "error");
        }
        if (!cancelled && session.refreshToken) await sync(database, true);
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
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync(db, false);
    });
    return () => subscription.remove();
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
      googleReconnectRequired,
      lastSyncedAt,
      loadDay: (date) => {
        if (!db) throw new Error("Database is not open");
        return loadDay(db, date);
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
        } catch (error) {
          if (error instanceof ApiError && error.code === "google_reconnect_required") {
            await writeSetting(db, "google_status", "revoked");
            setGoogleReconnectRequired(true);
          }
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
        } catch (error) {
          if (error instanceof ApiError && error.code === "google_reconnect_required") {
            setGoogleReconnectRequired(true);
          }
          return null;
        }
      },
      reconnectGoogle: async () => {
        if (!db) return;
        const session = await signInWithGoogle();
        await saveSession(session);
        await writeSetting(db, "google_status", "active");
        setGoogleReconnectRequired(false);
        if (mode !== "account") {
          await enterAccountMode(db);
          await writeAccount(db, session.user.email, session.user.display_name);
          setMode("account");
          setAccount({ email: session.user.email, displayName: session.user.display_name });
        }
        await sync(db, true);
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
        await writeSetting(db, "google_status", "");
        await writeSetting(db, "last_synced_at", "");
        await writeSetting(db, "insight_cache", "");
        setMode("demo");
        setAccount(null);
        setGoogleReconnectRequired(false);
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
        const session = await signInWithGoogle();
        await saveSession(session);
        await enterAccountMode(db);
        await writeAccount(db, session.user.email, session.user.display_name);
        if ((await readSetting(db, "ai_photo_consent_version")) === AI_PHOTO_CONSENT_VERSION) {
          await writeSetting(db, "ai_photo_consent_pending", "1");
          setPhotoConsent(true);
        }
        setMode("account");
        setAccount({ email: session.user.email, displayName: session.user.display_name });
        setGoals(await readGoals(db));
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
        await writeSetting(db, "google_status", "");
        await writeSetting(db, "last_synced_at", "");
        setMode("demo");
        setAccount(null);
        setGoogleReconnectRequired(false);
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
        if (!db) return;
        try {
          const provider = getHealthProvider();
          if (provider.id === "healthkit" && (await provider.getPermissionState()) !== "authorized") {
            await provider.requestPermissions();
          }
        } catch (error) {
          setSyncError(error instanceof Error ? error.message : "Apple Health sync failed");
          setHealth(await readHealthConnection(db));
          return;
        }
        if (mode !== "account") {
          setHealth(await readHealthConnection(db));
          return;
        }
        await sync(db, true);
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
      },
      addMealPhoto: async (uri) => {
        if (!db || mode !== "account") return "Sign in with Google before analyzing a meal photo.";
        const prepared = await prepareMealImage(uri);
        const result = await importPreparedPhoto(db, prepared, { ...capturedToday(), source: "manual" });
        setRefreshToken((token) => token + 1);
        if (result.reconnect) {
          setSyncError(result.message);
          await writeSetting(db, "google_status", "revoked");
          setGoogleReconnectRequired(true);
        }
        void sync(db, true);
        return result.message;
      },
      scanMealPhotos: async () => {
        if (!db || mode !== "account" || !photoConsent) return "";
        const result = await scanRecentPhotos(db);
        if (result.imported > 0) {
          setRefreshToken((token) => token + 1);
          void sync(db, true);
        }
        return result.status === "empty" ? "" : result.message;
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
    [account, db, goals, googleReconnectRequired, health, lastSyncedAt, mode, pending, photoConsent, refreshToken, syncError, syncing],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside StoreProvider");
  return store;
}

export { AuthCancelled };
