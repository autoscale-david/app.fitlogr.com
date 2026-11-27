import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import type { PhotoUrlResponse } from "@fitlogr/shared";
import { OfflineError, api } from "../services/api";
import { useStore } from "../services/store";
import { colors } from "../theme";

const cache = new Map<string, { url: string; expiresAt: number }>();

/** Meals saved by an older build keep their photo in Google Photos. Returns null when there is none. */
async function remoteUrl(photoId: string): Promise<string | null> {
  const cached = cache.get(photoId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const body = await api.send<PhotoUrlResponse>("GET", `/photos/${photoId}/url`);
  if (body.status !== "ok" || !body.url) return null;
  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 20 * 60 * 1000;
  cache.set(photoId, { url: body.url, expiresAt });
  return body.url;
}

/**
 * Shows a meal photo from this phone: the kept thumbnail, then the photo in the library, then the
 * compressed copy from when it was analysed. A remote URL is the last fallback, for older meals.
 */
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
  // The store object changes on every sync tick. A ref keeps that from reloading every photo.
  const store = useStore();
  const lookup = useRef(store.localMealPhoto);
  lookup.current = store.localMealPhoto;
  const [sources, setSources] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  // A ref, not state: marking it must not re-run (and so cancel) the effect that is fetching.
  const triedRemote = useRef(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!photoId) return;
    let cancelled = false;
    setSources([]);
    setIndex(0);
    triedRemote.current = false;
    setNote(null);
    void lookup
      .current(photoId)
      .catch(() => null)
      .then((local) => {
        if (cancelled) return;
        const onPhone = [local?.thumbUri, local?.libraryId, local?.fileUri].filter((uri): uri is string => Boolean(uri));
        if (onPhone.length > 0) setSources(onPhone);
        else setIndex(-1);
      });
    return () => {
      cancelled = true;
    };
  }, [photoId]);

  // Out of copies on the phone: ask the server once.
  useEffect(() => {
    if (!photoId || triedRemote.current) return;
    const exhausted = index === -1 || (sources.length > 0 && index >= sources.length);
    if (!exhausted) return;
    triedRemote.current = true;
    let cancelled = false;
    remoteUrl(photoId)
      .then((url) => {
        if (cancelled) return;
        if (url) {
          setSources([url]);
          setIndex(0);
        } else setNote("Photo unavailable");
      })
      .catch((error: unknown) => {
        if (!cancelled) setNote(error instanceof OfflineError ? "Photo unavailable offline" : "Photo unavailable");
      });
    return () => {
      cancelled = true;
    };
    // Re-run only when the photo changes or the phone's copies run out, never because of its own result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoId, index === -1 || (sources.length > 0 && index >= sources.length)]);

  const url = index >= 0 && index < sources.length ? sources[index] : null;

  return (
    <View>
      <View style={[styles.frame, { width: size, height: size, borderRadius: radius }]}>
        {url ? (
          <Image
            source={{ uri: url }}
            style={styles.image}
            contentFit="cover"
            // This copy is gone (deleted from the library, cache cleared): try the next one.
            onError={() => setIndex((current) => (current === index ? current + 1 : current))}
          />
        ) : (
          <Ionicons name="image-outline" size={Math.round(size * 0.38)} color={colors.faint} />
        )}
      </View>
      {detailed && note && !url ? <Text style={styles.note}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: "#222428", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  image: { width: "100%", height: "100%" },
  note: { color: colors.muted, marginTop: 8, fontSize: 13 },
});
