import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

export function MealPhotoConsent({
  visible,
  onAgree,
  onDecline,
}: {
  visible: boolean;
  onAgree: () => void;
  onDecline: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDecline}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Analyze meal photos?</Text>
          <Text style={styles.body}>
            fitlogr compresses the photo, removes location and camera details, and sends it to fitlogr and OpenRouter to
            estimate the foods and calories. Confirmed meals are saved in a fitlogr album in your Google Photos. Photos
            are not used to train models, and you can mark any photo as not a meal.
          </Text>
          <Pressable style={styles.agree} onPress={onAgree}>
            <Text style={styles.agreeText}>Agree and continue</Text>
          </Pressable>
          <Pressable style={styles.decline} onPress={onDecline}>
            <Text style={styles.declineText}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.72)", justifyContent: "flex-end", padding: 16 },
  card: { backgroundColor: colors.card, borderRadius: 20, padding: 18 },
  title: { color: colors.text, fontSize: 22, fontWeight: "800" },
  body: { color: colors.muted, marginTop: 10, fontSize: 15, lineHeight: 21 },
  agree: { marginTop: 18, backgroundColor: colors.green, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  agreeText: { color: "#062214", fontWeight: "800" },
  decline: { marginTop: 8, paddingVertical: 12, alignItems: "center" },
  declineText: { color: colors.muted, fontWeight: "700" },
});
