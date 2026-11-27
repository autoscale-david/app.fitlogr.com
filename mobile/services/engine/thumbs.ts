import { Directory, File, Paths } from "expo-file-system";

/** A small JPEG kept for meals. Rejected photos are never copied. */
export async function copyMealThumb(sourceUri: string, mealId: string): Promise<string | null> {
  try {
    const dir = new Directory(Paths.document, "meal-thumbs");
    if (!dir.exists) dir.create();
    const dest = new File(dir, `${mealId}.jpg`);
    if (dest.exists) return dest.uri;
    await new File(sourceUri).copy(dest);
    return dest.uri;
  } catch {
    return null;
  }
}
