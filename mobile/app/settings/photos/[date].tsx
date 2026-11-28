import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { DetailScreen, ui } from "../../../components/settingsUi";
import { listAuditEntries, type AuditEntry, type AuditFilter } from "../../../services/engine/auditQuery";
import { openFitlogrDatabase } from "../../../services/db";
import { localDateISO } from "../../../services/dates";
import { prepareLibraryPhoto } from "../../../services/photos/library";
import { importPreparedPhoto } from "../../../services/photos/upload";
import { api } from "../../../services/api";
import { useStore } from "../../../services/store";
import { colors } from "../../../theme";

const FILTERS: { id: AuditFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "sent", label: "Sent to AI" },
  { id: "meals", label: "Meals" },
  { id: "kept", label: "Kept on phone" },
];

export default function PhotoDayScreen() {
  const params = useLocalSearchParams<{ date: string }>();
  const date = params.date;
  const store = useStore();
  const [filter, setFilter] = useState<AuditFilter>("all");
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!date) return;
    const db = await openFitlogrDatabase();
    setRows(await listAuditEntries(db, date, filter));
  }, [date, filter]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const open = rows.find((row) => row.id === selected) ?? null;

  return (
    <DetailScreen title={date || "Photo log"}>
      <View style={styles.filters}>
        {FILTERS.map((item) => (
          <Pressable key={item.id} onPress={() => setFilter(item.id)} style={[styles.chip, filter === item.id && styles.chipOn]}>
            <Text style={styles.chipText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      {rows.map((row) => (
        <Pressable key={row.id} style={styles.line} onPress={() => setSelected(row.id)}>
          <PhotoThumb row={row} />
          <View style={{ flex: 1 }}>
            <Text style={ui.cardTitle}>{clock(row.capturedAt)}</Text>
            <Text style={ui.body}>
              {row.verdict ?? "unchecked"}
              {row.labels[0] ? ` · ${row.labels[0].id} ${Math.round(row.labels[0].confidence * 100)}%` : ""}
            </Text>
            <Text style={ui.meta}>
              {aiLine(row)}
              {row.estimate?.kcal !== undefined ? ` · ${Math.round(row.estimate.kcal)} kcal` : ""}
            </Text>
          </View>
        </Pressable>
      ))}
      {open ? (
        <View style={ui.card}>
          <PhotoThumb row={open} large />
          <Text style={ui.body}>{open.labels.map((label) => `${label.id} ${Math.round(label.confidence * 100)}%`).join(" · ") || "No labels"}</Text>
          {open.estimate?.reason ? <Text style={ui.body}>{open.estimate.reason}</Text> : null}
          {open.estimate?.items?.length ? (
            <Text style={ui.meta}>{open.estimate.items.map((item) => `${item.name} ${Math.round(item.kcal)}`).join(" · ")}</Text>
          ) : null}
          <Text style={ui.meta}>
            Classified {open.classifiedAt ?? "—"} · analysed {open.aiAt ?? "—"}
          </Text>
          {open.error ? <Text style={ui.error}>{open.error}</Text> : null}
          <Pressable
            style={ui.secondary}
            onPress={() => {
              void (async () => {
                const db = await openFitlogrDatabase();
                const prepared = await prepareLibraryPhoto(open.id);
                const result = await importPreparedPhoto(db, prepared, {
                  capturedAt: open.capturedAt ?? new Date().toISOString(),
                  localDate: open.captureDate || localDateISO(),
                  source: "device_library",
                  assetId: open.id,
                  forceMeal: true,
                  onDeviceVerdict: open.verdict ?? undefined,
                  onDeviceLabels: open.labels,
                });
                setNote(result.message);
                await load();
              })();
            }}
          >
            <Text style={ui.secondaryText}>Analyse anyway</Text>
          </Pressable>
          <Pressable
            style={ui.secondary}
            onPress={() => {
              void (async () => {
                if (open.remotePhotoId) await api.send("POST", `/photos/${open.remotePhotoId}/exclude`, { reason: "not_meal" });
                if (open.mealId) await store.deleteMeal(open.mealId, false, open.remotePhotoId);
                const db = await openFitlogrDatabase();
                await db.runAsync(`UPDATE local_media_assets SET scan_status = 'excluded', updated_at = ? WHERE local_asset_id = ?`, new Date().toISOString(), open.id);
                setSelected(null);
                await load();
              })();
            }}
          >
            <Text style={ui.secondaryText}>Not a meal</Text>
          </Pressable>
          {open.mealId ? (
            <Pressable style={ui.secondary} onPress={() => router.push({ pathname: "/meal/[id]", params: { id: open.mealId! } })}>
              <Text style={ui.secondaryText}>Open meal</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {note ? <Text style={ui.body}>{note}</Text> : null}
    </DetailScreen>
  );
}

function PhotoThumb({ row, large }: { row: AuditEntry; large?: boolean }) {
  // Rejected photos are shown from the library id only. fitlogr does not keep a copy of them.
  const uri = row.thumbUri || (row.id.startsWith("ph://") || row.id.startsWith("file:") ? row.id : null);
  const size = large ? 220 : 56;
  const [failed, setFailed] = useState(false);
  if (!uri || failed) {
    return (
      <View style={[styles.thumb, { width: size, height: size }]}>
        <Text style={styles.placeholder}>Photo</Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri }}
      style={{ width: size, height: size, borderRadius: 10, backgroundColor: "#222428" }}
      contentFit="cover"
      onError={() => setFailed(true)}
    />
  );
}

function aiLine(row: AuditEntry): string {
  if (row.aiState === "not_sent") return "not sent";
  if (row.classification === "meal" || row.aiState === "meal") return "meal";
  if (row.classification === "workout" || row.aiState === "workout") return "workout";
  if (row.classification === "ignore" || row.aiState === "ignore") return "none";
  return row.aiState;
}

function clock(iso: string | null): string {
  if (!iso) return "Unknown time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const styles = StyleSheet.create({
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chip: { backgroundColor: "#222428", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  chipOn: { backgroundColor: "#163524" },
  chipText: { color: colors.text, fontWeight: "700", fontSize: 13 },
  line: { flexDirection: "row", gap: 10, alignItems: "center", marginTop: 10 },
  thumb: { backgroundColor: "#222428", borderRadius: 10, alignItems: "center", justifyContent: "center" },
  placeholder: { color: colors.faint, fontSize: 11 },
});
