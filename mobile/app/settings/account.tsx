import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { SessionExpiredBanner } from "../../components/AccountBanners";
import { DetailScreen, ui } from "../../components/settingsUi";
import { AuthCancelled, useStore } from "../../services/store";

export default function AccountScreen() {
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  return (
    <DetailScreen title="Account">
      <SessionExpiredBanner
        visible={store.sessionExpired}
        busy={reconnecting}
        onSignIn={() => {
          setReconnecting(true);
          store
            .signIn()
            .catch((error: unknown) => {
              if (error instanceof AuthCancelled) return;
              Alert.alert("Sign in", error instanceof Error ? error.message : "Sign-in failed");
            })
            .finally(() => setReconnecting(false));
        }}
      />
      <View style={ui.card}>
        {store.account ? (
          <>
            <Text style={ui.cardTitle}>{store.account.displayName || "Google account"}</Text>
            <Text style={ui.body}>{store.account.email}</Text>
            <Text style={ui.meta}>Signed in with Google. Meals, weight, and your plan sync to fitlogr.com.</Text>
            <Pressable
              style={ui.secondary}
              onPress={() => {
                Alert.alert("Sign out", "This phone returns to the sample preview. Your fitlogr account stays on the server.", [
                  { text: "Cancel", style: "cancel" },
                  { text: "Sign out", style: "destructive", onPress: () => void store.signOut() },
                ]);
              }}
            >
              <Text style={ui.secondaryText}>Sign out</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={ui.cardTitle}>Not signed in</Text>
            <Text style={ui.body}>Connect Google to save your plan, meals, and weight on fitlogr.com. Until then, this phone shows the sample day.</Text>
            <Pressable
              style={ui.primary}
              disabled={busy}
              onPress={() => {
                setBusy(true);
                store
                  .signIn()
                  .catch((error: unknown) => {
                    if (error instanceof AuthCancelled) return;
                    Alert.alert("Google sign-in", error instanceof Error ? error.message : "Sign-in failed");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? <ActivityIndicator color="#062214" /> : <Text style={ui.primaryText}>Continue with Google</Text>}
            </Pressable>
          </>
        )}
      </View>
    </DetailScreen>
  );
}
