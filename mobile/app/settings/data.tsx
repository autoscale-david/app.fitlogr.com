import { useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SyncStatusBanner } from "../../components/AccountBanners";
import { ImportHistoryCard } from "../../components/ImportHistoryCard";
import { DetailScreen, ui } from "../../components/settingsUi";
import { useStore } from "../../services/store";
import { colors } from "../../theme";

export default function MyDataScreen() {
  const store = useStore();
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const signedIn = store.mode === "account";

  return (
    <DetailScreen title="My Data">
      <SyncStatusBanner
        visible={signedIn}
        pending={store.pending}
        lastSyncedAt={store.lastSyncedAt}
        syncing={store.syncing}
        error={store.syncError}
        onRetry={() => void store.sync(true)}
      />
      <ImportHistoryCard signedIn={signedIn} />

      <View style={ui.card}>
        <Text style={ui.cardTitle}>Data & privacy</Text>
        {signedIn ? (
          <>
            <Text style={ui.body}>Download a JSON copy of your fitlogr profile, meals, photos metadata, health records, and daily summaries.</Text>
            <View style={styles.actions}>
              <Pressable
                style={[ui.secondary, styles.action]}
                disabled={exporting}
                onPress={() => {
                  setExporting(true);
                  store
                    .exportAccount()
                    .catch((error: unknown) => {
                      Alert.alert("Export", error instanceof Error ? error.message : "Export failed");
                    })
                    .finally(() => setExporting(false));
                }}
              >
                {exporting ? <ActivityIndicator color={colors.text} /> : <Text style={ui.secondaryText}>Export My Data</Text>}
              </Pressable>
              <Pressable style={[ui.danger, styles.action]} onPress={() => setConfirmDelete(true)}>
                <Text style={ui.dangerText}>Delete Account</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <Text style={ui.body}>Sign in to export or delete the fitlogr account. The sample day stays on this phone.</Text>
        )}
      </View>

      {store.mode === "demo" ? (
        <Pressable style={ui.secondary} onPress={() => void store.restoreSample()}>
          <Text style={ui.secondaryText}>Restore sample day</Text>
        </Pressable>
      ) : null}

      <Modal visible={confirmDelete} transparent animationType="fade" onRequestClose={() => setConfirmDelete(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={ui.cardTitle}>Delete your fitlogr account?</Text>
            <Text style={ui.body}>
              This permanently deletes your fitlogr profile, meals, health records, and settings. Your Google Photos library, including the fitlogr album and meal photos, will not be deleted.
            </Text>
            <Pressable
              style={ui.danger}
              disabled={deleting}
              onPress={() => {
                setDeleting(true);
                store
                  .deleteAccount()
                  .then(() => setConfirmDelete(false))
                  .catch((error: unknown) => {
                    Alert.alert("Delete account", error instanceof Error ? error.message : "Could not delete the account");
                  })
                  .finally(() => setDeleting(false));
              }}
            >
              {deleting ? <ActivityIndicator color={colors.fat} /> : <Text style={ui.dangerText}>Delete fitlogr data</Text>}
            </Pressable>
            <Pressable style={ui.secondary} onPress={() => setConfirmDelete(false)}>
              <Text style={ui.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </DetailScreen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: 8 },
  action: { flex: 1 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.72)", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: colors.card, borderRadius: 14, padding: 14 },
});
