import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { DetailScreen, ui } from "../../../components/settingsUi";
import { listAuditEntries, type AuditEntry, type AuditFilter } from "../../../services/engine/auditQuery";
import { openFitlogrDatabase } from "../../../services/db";
import { localDateISO } from "../../../services/dates";
import { recordImport } from "../../../services/engine/photoPass";
import { prepareLibraryPhoto } from "../../../services/photos/library";
import { importPreparedPhoto } from "../../../services/photos/upload";
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
  const [working, setWorking] = useState(false);

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
              {verdictLine(row.verdict)}
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
          <PhotoThumb key={open.id} row={open} large />
          <Text style={ui.body}>{open.labels.map((label) => `${label.id} ${Math.round(label.confidence * 100)}%`).join(" · ") || "No labels"}</Text>
          {open.estimate?.reason ? <Text style={ui.body}>{open.estimate.reason}</Text> : null}
          {open.estimate?.items?.length ? (
            <Text style={ui.meta}>{open.estimate.items.map((item) => `${item.name} ${Math.round(item.kcal)}`).join(" · ")}</Text>
          ) : null}
          <Text style={ui.meta}>
            Classified {open.classifiedAt ?? "—"} · analysed {open.aiAt ?? "—"}
          </Text>
          {open.error ? <Text style={ui.error}>{open.error}</Text> : null}
          {/* A logged meal has nothing to re-analyse; sending it again could log it twice. */}
          {open.aiState === "meal" ? null : (
          <Pressable
            style={ui.secondary}
            disabled={working}
            onPress={() => {
              setWorking(true);
              setNote(null);
              void (async () => {
                try {
                  const db = await openFitlogrDatabase();
                  const prepared = await prepareLibraryPhoto(open.id);
                  const capturedAtMs = open.capturedAt ? Date.parse(open.capturedAt) : Date.now();
                  const result = await importPreparedPhoto(db, prepared, {
                    capturedAt: new Date(capturedAtMs).toISOString(),
                    localDate: open.captureDate || localDateISO(),
                    source: "device_library",
                    assetId: open.id,
                    forceMeal: true,
                    onDeviceVerdict: open.verdict ?? undefined,
                    onDeviceLabels: open.labels,
                  });
                  // Update the log row too, so it shows the new result and the meal it created.
                  await recordImport(db, { assetId: open.id, capturedAtMs, source: "library", preparedUri: prepared.uri, result });
                  setNote(result.message);
                  void store.sync(true);
                } catch (error) {
                  setNote(error instanceof Error ? error.message : "The photo could not be analyzed.");
                } finally {
                  setWorking(false);
                  await load();
                }
              })();
            }}
          >
            <Text style={ui.secondaryText}>{working ? "Analysing…" : "Analyse anyway"}</Text>
          </Pressable>
          )}
          <Pressable
            style={ui.secondary}
            disabled={working}
            onPress={() => {
              void (async () => {
                try {
                  // Deleting the meal also tells the server to exclude the photo, through the offline queue.
                  if (open.mealId) await store.deleteMeal(open.mealId, false, open.remotePhotoId);
                  const db = await openFitlogrDatabase();
                  await db.runAsync(
                    `UPDATE local_media_assets SET scan_status = 'excluded', meal_id = NULL, updated_at = ? WHERE local_asset_id = ?`,
                    new Date().toISOString(),
                    open.id,
                  );
                  setSelected(null);
                } catch (error) {
                  setNote(error instanceof Error ? error.message : "That could not be saved.");
                } finally {
                  await load();
                }
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

/** What the AI said, and what fitlogr did with it. The state decides; the model's word is detail. */
function aiLine(row: AuditEntry): string {
  switch (row.aiState) {
    case "not_sent":
      return "AI: not sent";
    case "queued":
      return "AI: waiting";
    case "meal":
      return "AI: meal · logged";
    case "workout":
      return "AI: workout";
    case "ignore":
      return row.classification === "meal" ? "AI: meal, too unsure to log" : "AI: none";
    case "duplicate":
      return "AI: already logged";
    case "excluded":
      return "AI: excluded";
    case "error":
      return "AI: error, will retry";
    case "failed":
      return "AI: failed";
    default:
      return `AI: ${row.aiState}`;
  }
}

function verdictLine(verdict: string | null): string {
  switch (verdict) {
    case "food":
      return "On phone: food";
    case "workout":
      return "On phone: workout";
    case "uncertain":
      return "On phone: unsure";
    case "not_relevant":
      return "On phone: not food";
    case "screenshot":
      return "On phone: screenshot";
    case "unreadable":
      return "On phone: could not read";
    default:
      return "On phone: not checked";
  }
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
