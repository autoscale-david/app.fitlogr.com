import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import {
  loadDay,
  loggedDates,
  migrate,
  readGoals,
  restoreSample,
  writeGoals,
  type DayLog,
  type Goals,
} from "./db";

interface Store {
  ready: boolean;
  goals: Goals | null;
  refreshToken: number;
  loadDay: (date: string) => Promise<DayLog>;
  loggedDates: () => Promise<string[]>;
  saveGoals: (goals: Goals) => Promise<void>;
  restoreSample: () => Promise<void>;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<SQLiteDatabase | null>(null);
  const [goals, setGoals] = useState<Goals | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    openDatabaseAsync("fitlogr.db")
      .then(async (database) => {
        await migrate(database);
        const nextGoals = await readGoals(database);
        if (!cancelled) {
          setDb(database);
          setGoals(nextGoals);
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to open fitlogr database", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<Store>(
    () => ({
      ready: db !== null && goals !== null,
      goals,
      refreshToken,
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
        setRefreshToken((token) => token + 1);
      },
      restoreSample: async () => {
        if (!db) return;
        await restoreSample(db);
        setGoals(await readGoals(db));
        setRefreshToken((token) => token + 1);
      },
    }),
    [db, goals, refreshToken],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside StoreProvider");
  return store;
}
