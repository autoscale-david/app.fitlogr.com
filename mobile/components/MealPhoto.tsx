import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { PhotoUrlResponse } from "@fitlogr/shared";
import { OfflineError, api } from "../services/api";
import { useStore } from "../services/store";
import { colors } from "../theme";

const cache = new Map<string, { url: string; expiresAt: number }>();

/**
 * Shows a meal photo from this phone first (the compressed file, then the library asset).
 * A remote URL is only the last fallback, for meals saved by an older build.
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
  const lookup = useStore().localMealPhoto;
  const [url, setUrl] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [phoneCopy, setPhoneCopy] = useState(false);

  useEffect(() => {
    if (!photoId) return;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    setNote(null);
    setPhoneCopy(false);

    async function showRemote(id: string) {
      const cached = cache.get(id);
      if (cached && cached.expiresAt > Date.now()) {
        if (!cancelled) {
          setPhoneCopy(false);
          setUrl(cached.url);
          setFailed(false);
          setNote(null);
        }
        return;
      }
      try {
        const body = await api.send<PhotoUrlResponse>("GET", `/photos/${id}/url`);
        if (cancelled) return;
        if (body.status === "ok" && body.url) {
          const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 20 * 60 * 1000;
          cache.set(id, { url: body.url, expiresAt });
          setPhoneCopy(false);
          setUrl(body.url);
          setFailed(false);
          setNote(null);
          return;
        }
        setUrl(null);
        setFailed(true);
        setNote("Photo unavailable");
      } catch (error) {
        if (cancelled) return;
        setUrl(null);
        setFailed(true);
        setNote(error instanceof OfflineError ? "Photo unavailable offline" : "Photo unavailable");
      }
    }

    lookup(photoId).then((local) => {
      if (cancelled) return;
      const onPhone = local?.fileUri ?? local?.libraryId ?? null;
      if (onPhone) {
        setPhoneCopy(true);
        setUrl(onPhone);
        return;
      }
      void showRemote(photoId);
    });

    return () => {
      cancelled = true;
    };
  }, [photoId, lookup]);

  return (
    <View>
      <View style={[styles.frame, { width: size, height: size, borderRadius: radius }]}>
        {url && !failed ? (
          <Image
            source={{ uri: url }}
            style={styles.image}
            onError={() => {
              if (phoneCopy && photoId) {
                setPhoneCopy(false);
                setUrl(null);
                const cached = cache.get(photoId);
                if (cached && cached.expiresAt > Date.now()) {
                  setUrl(cached.url);
                  return;
                }
                api
                  .send<PhotoUrlResponse>("GET", `/photos/${photoId}/url`)
                  .then((body) => {
                    if (body.status === "ok" && body.url) {
                      const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 20 * 60 * 1000;
                      cache.set(photoId, { url: body.url, expiresAt });
                      setUrl(body.url);
                      setFailed(false);
                      setNote(null);
                      return;
                    }
                    setFailed(true);
                    setNote("Photo unavailable");
                  })
                  .catch((error: unknown) => {
                    setFailed(true);
                    setNote(error instanceof OfflineError ? "Photo unavailable offline" : "Photo unavailable");
                  });
                return;
              }
              setFailed(true);
              setNote((current) => current ?? "Photo unavailable");
            }}
          />
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
