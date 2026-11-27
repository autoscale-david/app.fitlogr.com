import { useCallback, useState } from "react";
import { Pressable, Text } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { DetailScreen, ui } from "../../components/settingsUi";
import { listPasses, type PassLogEntry } from "../../services/engine/activity";
import { listAuditDays, type AuditDay } from "../../services/engine/auditQuery";
import { getClassifier, CLASSIFIER_POLICY_VERSION } from "../../services/engine/classifier";
import { openFitlogrDatabase } from "../../services/db";
import { Share } from "react-native";

export default function PhotoLogScreen() {
  const [days, setDays] = useState<AuditDay[]>([]);
  const [passes, setPasses] = useState<PassLogEntry[]>([]);
  const classifier = getClassifier();

  const load = useCallback(async () => {
    const db = await openFitlogrDatabase();
    setDays(await listAuditDays(db));
    setPasses(await listPasses(db));
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const totals = days.reduce(
    (sum, day) => ({ photos: sum.photos + day.photos, food: sum.food + day.food, meals: sum.meals + day.meals }),
    { photos: 0, food: 0, meals: 0 },
  );

  return (
    <DetailScreen title="Photo log">
      {days.length === 0 ? <Text style={ui.body}>No photos have been checked yet.</Text> : null}
      {days.map((day) => (
        <Pressable key={day.date} style={ui.card} onPress={() => router.push({ pathname: "/settings/photos/[date]", params: { date: day.date } })}>
          <Text style={ui.cardTitle}>{day.date}</Text>
          <Text style={ui.body}>
            {day.photos} photos · {day.food} looked like food · {day.meals} meals · {day.workouts} {day.workouts === 1 ? "workout" : "workouts"}
          </Text>
        </Pressable>
      ))}
      <Text style={ui.cardTitle}>Diagnostics</Text>
      <Text style={ui.body}>
        Classifier {classifier.id} · policy {CLASSIFIER_POLICY_VERSION}. {classifier.available ? "On this phone." : "Missing, so automatic scanning is off."}
      </Text>
      <Text style={ui.meta}>
        {totals.photos} photos checked · {totals.food} looked like food · {totals.meals} meals
      </Text>
      {passes.slice(0, 8).map((pass) => (
        <Text key={pass.ranAt} style={ui.meta}>
          {pass.ranAt.slice(11, 16)} {pass.reason} · {Math.round(pass.durationMs / 1000)}s
          {pass.error ? ` · ${pass.error}` : ""}
        </Text>
      ))}
      <Pressable
        style={ui.secondary}
        onPress={() => {
          const labels = classifier.supportedLabels();
          void Share.share({ message: labels.length ? labels.join("\n") : "This phone did not return a label list." });
        }}
      >
        <Text style={ui.secondaryText}>Export labels</Text>
      </Pressable>
    </DetailScreen>
  );
}
