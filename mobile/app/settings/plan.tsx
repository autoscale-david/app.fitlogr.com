import { useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { CaloriePlanCard } from "../../components/CaloriePlanCard";
import { DetailScreen } from "../../components/settingsUi";
import { useGoalsDraft } from "../../services/useGoalsDraft";

export default function CaloriePlanScreen() {
  const [draft, save] = useGoalsDraft();
  const params = useLocalSearchParams<{ focus?: string }>();
  const [openEndsSignal, setOpenEndsSignal] = useState(0);

  useEffect(() => {
    if (params.focus !== "plan-end") return;
    const timer = setTimeout(() => {
      setOpenEndsSignal((signal) => signal + 1);
      router.setParams({ focus: "" });
    }, 250);
    return () => clearTimeout(timer);
  }, [params.focus]);

  return (
    <DetailScreen title="Calorie Plan">
      {draft ? <CaloriePlanCard plan={draft.plan} onChange={(plan) => save({ ...draft, plan })} openEndsSignal={openEndsSignal} /> : null}
    </DetailScreen>
  );
}
