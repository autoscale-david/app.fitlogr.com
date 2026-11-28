import { useCallback, useState } from "react";
import { Pressable, Text } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { DetailScreen, ui } from "../../components/settingsUi";
import { listPasses, type PassLogEntry } from "../../services/engine/activity";
import { listAuditDays, type AuditDay } from "../../services/engine/auditQuery";
import { getClassifier, CLASSIFIER_POLICY_VERSION } from "../../services/engine/classifier";
import { openFitlogrDatabase } from "../../services/db";
import { Share } from "react-native";

function passLine(pass: PassLogEntry): string {
  const when = new Date(pass.ranAt);
  const time = Number.isNaN(when.getTime())
    ? pass.ranAt
    : when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const parts = [`${time} · ${pass.reason}`, `${Math.max(1, Math.round(pass.durationMs / 1000))}s`];
  if (pass.counts) parts.push(`${pass.counts.checked} checked, ${pass.counts.analysed} analysed, ${pass.counts.meals} meals, ${pass.counts.waiting} waiting`);
  if (pass.error) parts.push(pass.error);
  return parts.join(" · ");
}

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
      <Text style={ui.cardTitle}>Activity</Text>
      <Text style={ui.meta}>
        The last {passes.length} times fitlogr checked for photos and Health data. "(background)" means iOS woke the app while it was closed.
      </Text>
      {passes.map((pass, index) => (
        <Text key={`${pass.ranAt}-${index}`} style={ui.meta}>
          {passLine(pass)}
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
