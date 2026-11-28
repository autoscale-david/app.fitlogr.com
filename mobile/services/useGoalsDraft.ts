import { useCallback, useEffect, useState } from "react";
import type { Goals } from "./db";
import { useStore } from "./store";

/** Local copy of the saved goals so edits render immediately while the save runs. */
export function useGoalsDraft(): [Goals | null, (next: Goals) => void] {
  const store = useStore();
  const [draft, setDraft] = useState<Goals | null>(store.goals);

  useEffect(() => {
    setDraft(store.goals);
  }, [store.goals, store.refreshToken]);

  const save = useCallback(
    (next: Goals) => {
      setDraft(next);
      void store.saveGoals(next);
    },
    [store],
  );
  return [draft, save];
}
