import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { PhotoUrlResponse } from "@fitlogr/shared";
import { ApiError, OfflineError, api } from "../services/api";
import { colors } from "../theme";

const cache = new Map<string, { url: string; expiresAt: number }>();

export function MealPhoto({
  photoId,
  size = 74,
  radius = 16,
  detailed = false,
}: {
  photoId?: string | null;
  size?: number;
  radius?: number;
  detailed?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!photoId) return;
    const cached = cache.get(photoId);
    if (cached && cached.expiresAt > Date.now()) {
      setUrl(cached.url);
      setFailed(false);
      setNote(null);
      return;
    }
    let cancelled = false;
    api
      .send<PhotoUrlResponse>("GET", `/photos/${photoId}/url`)
      .then((body) => {
        if (cancelled) return;
        if (body.status === "ok" && body.url) {
          const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 20 * 60 * 1000;
          cache.set(photoId, { url: body.url, expiresAt });
          setUrl(body.url);
          setFailed(false);
          setNote(null);
          return;
        }
        setUrl(null);
        setFailed(true);
        setNote(body.status === "missing" ? "Photo removed from Google Photos" : "Photo unavailable");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setUrl(null);
        setFailed(true);
        if (error instanceof ApiError && error.code === "google_reconnect_required") setNote("Reconnect Google to view this photo");
        else if (error instanceof OfflineError) setNote("Photo unavailable offline");
        else setNote("Photo unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [photoId]);

  return (
    <View>
      <View style={[styles.frame, { width: size, height: size, borderRadius: radius }]}>
        {url && !failed ? (
          <Image source={{ uri: url }} style={styles.image} onError={() => setFailed(true)} />
        ) : (
          <Ionicons name="image-outline" size={Math.round(size * 0.38)} color={colors.faint} />
        )}
      </View>
      {detailed && note ? <Text style={styles.note}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: "#222428", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  image: { width: "100%", height: "100%" },
  note: { color: colors.muted, marginTop: 8, fontSize: 13 },
});
