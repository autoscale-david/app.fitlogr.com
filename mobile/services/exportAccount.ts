import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform, Share } from "react-native";

/** Saves the export on the phone and opens the system share sheet. Works in Expo Go. */
export async function shareAccountExport(json: string): Promise<void> {
  const file = new File(Paths.cache, "fitlogr-export.json");
  if (file.exists) file.delete();
  file.create();
  await file.write(json);
  try {
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/json",
        UTI: "public.json",
        dialogTitle: "Export fitlogr data",
      });
      return;
    }
  } catch (error) {
    if (shareDismissed(error)) return;
  }
  try {
    if (Platform.OS === "ios") {
      await Share.share({ title: "fitlogr data export", url: file.uri });
      return;
    }
    await Share.share({ title: "fitlogr data export", message: json });
  } catch (error) {
    if (shareDismissed(error)) return;
    throw error;
  }
}

function shareDismissed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cancel|dismiss|did not share/i.test(message);
}
