import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { AI_PHOTO_CONSENT_VERSION } from "@fitlogr/shared";
import { api, SessionExpired } from "./api";
import { AuthCancelled, signInWithGoogle } from "./auth";
import {
  enterAccountMode,
  enterDemoMode,
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
  loadDay: (date: string) => Promise<DayLog>;
  loggedDates: () => Promise<string[]>;
  saveGoals: (goals: Goals) => Promise<void>;
  restoreSample: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  sync: (force?: boolean) => Promise<void>;
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

  async function refreshPending(database: SQLiteDatabase) {
    setPending(await pendingChanges(database));
  }

  async function runSync(database: SQLiteDatabase, force = false) {
    const currentMode = (await readSetting(database, "data_mode")) === "account" ? "account" : "demo";
    if (currentMode !== "account") {
      setRefreshToken((token) => token + 1);
      return;
    }
    setSyncing(true);
    try {
      await syncAccount(database, force);
      await retryPendingPhotos(database);
      setGoals(await readGoals(database));
      setSyncError(null);
      setRefreshToken((token) => token + 1);
    } catch (error) {
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
      loadDay: (date) => {
        if (!db) throw new Error("Database is not open");
        return loadDay(db, date);
      },
      loggedDates: () => {
        if (!db) throw new Error("Database is not open");
        return loggedDates(db);
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
        setMode("demo");
        setAccount(null);
        setSyncError(null);
        setGoals(await readGoals(db));
        setPending(0);
        setRefreshToken((token) => token + 1);
      },
      sync: (force = false) => {
        if (!db) return Promise.resolve();
        return sync(db, force);
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
        if (result.reconnect) setSyncError(result.message);
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
    [account, db, goals, mode, pending, photoConsent, refreshToken, syncError, syncing],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside StoreProvider");
  return store;
}

export { AuthCancelled };
