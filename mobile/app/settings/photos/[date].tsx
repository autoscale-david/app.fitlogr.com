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

  const detail = open ? (
    <View style={ui.card}>
      <PhotoThumb key={open.id} row={open} large />
      <Text style={ui.cardTitle}>{verdictLine(open.verdict)}</Text>
      <Text style={ui.body}>{open.labels.map((label) => `${label.id} ${Math.round(label.confidence * 100)}%`).join(" · ") || "No labels"}</Text>
      <Text style={ui.cardTitle}>
        {aiLine(open)}
        {estimateLine(open)}
        {open.confidence !== null && open.aiState !== "not_sent" ? ` · ${Math.round(open.confidence * 100)}% sure` : ""}
      </Text>
      {open.estimate?.reason ? <Text style={ui.body}>{open.estimate.reason}</Text> : null}
      {open.estimate?.items?.length ? (
        <Text style={ui.meta}>{open.estimate.items.map((item) => `${item.name} ${Math.round(item.kcal)}`).join(" · ")}</Text>
      ) : null}
      <Text style={ui.meta}>
        Checked on phone {stamp(open.classifiedAt)} · analysed {stamp(open.aiAt)}
      </Text>
      {open.error ? <Text style={ui.error}>{open.error}</Text> : null}
      {note ? <Text style={ui.body}>{note}</Text> : null}
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
      {/* Only where there is something to undo or to hold back. */}
      {open.mealId || open.aiState === "queued" || open.aiState === "error" ? (
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
      ) : null}
      {open.mealId ? (
        <Pressable style={ui.secondary} onPress={() => router.push({ pathname: "/meal/[id]", params: { id: open.mealId! } })}>
          <Text style={ui.secondaryText}>Open meal</Text>
        </Pressable>
      ) : null}
    </View>
  ) : null;

  return (
    <DetailScreen title={date || "Photo log"}>
      <View style={styles.filters}>
        {FILTERS.map((item) => (
          <Pressable key={item.id} onPress={() => setFilter(item.id)} style={[styles.chip, filter === item.id && styles.chipOn]}>
            <Text style={styles.chipText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      {rows.length === 0 ? <Text style={ui.body}>No photos here.</Text> : null}
      {rows.map((row) => (
        <View key={row.id}>
          <Pressable
            style={styles.line}
            onPress={() => {
              setNote(null);
              setSelected((current) => (current === row.id ? null : row.id));
            }}
          >
            <PhotoThumb row={row} />
            <View style={{ flex: 1 }}>
              <Text style={ui.cardTitle}>{clock(row.capturedAt)}</Text>
              <Text style={ui.body}>
                {verdictLine(row.verdict)}
                {topLabels(row.labels, 3)}
              </Text>
              <Text style={ui.meta}>
                {aiLine(row)}
                {estimateLine(row)}
              </Text>
            </View>
          </Pressable>
          {/* Right under the photo that was tapped, so it is on screen in a long day. */}
          {row.id === selected ? detail : null}
        </View>
      ))}
      {note && !open ? <Text style={ui.body}>{note}</Text> : null}
    </DetailScreen>
  );
}

function PhotoThumb({ row, large }: { row: AuditEntry; large?: boolean }) {
  // Rejected photos are shown from the library id only. fitlogr does not keep a copy of them.
  const library = row.id.startsWith("ph://") || row.id.startsWith("file:") ? row.id : null;
  const sources = [row.thumbUri, library].filter((source, index, all): source is string => Boolean(source) && all.indexOf(source) === index);
  const size = large ? 220 : 56;
  const [tried, setTried] = useState(0);
  const uri = sources[tried];
  if (!uri) {
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
      // The kept copy is gone: show the photo from the library instead.
      onError={() => setTried((current) => current + 1)}
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

function topLabels(labels: AuditEntry["labels"], count: number): string {
  const top = [...labels].sort((a, b) => b.confidence - a.confidence).slice(0, count);
  return top.length ? ` · ${top.map((label) => `${label.id} ${Math.round(label.confidence * 100)}%`).join(", ")}` : "";
}

/** The estimate, where there is one: calories eaten for a meal, calories burned for a workout. */
function estimateLine(row: AuditEntry): string {
  const kcal = row.estimate?.kcal;
  if (typeof kcal !== "number" || kcal <= 0) return "";
  if (row.aiState === "workout" || row.classification === "workout") return ` · ${Math.round(kcal)} kcal burned`;
  return ` · ${Math.round(kcal)} kcal`;
}

function stamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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
