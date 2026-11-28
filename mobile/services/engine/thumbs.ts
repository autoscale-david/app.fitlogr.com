import { Directory, File, Paths } from "expo-file-system";

const THUMB_DIR = "meal-thumbs";

/**
 * Where a kept thumbnail is now. iOS can move the app's folder when a new build is installed, so a
 * stored full path goes stale. Only the file name is trusted; the folder is looked up each time.
 */
export function resolveThumb(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const name = stored.split("/").pop();
  if (!name || !name.endsWith(".jpg")) return stored;
  try {
    return new File(new Directory(Paths.document, THUMB_DIR), name).uri;
  } catch {
    return stored;
  }
}

/** A small JPEG kept for meals. Rejected photos are never copied. */
export async function copyMealThumb(sourceUri: string, mealId: string): Promise<string | null> {
  try {
    const dir = new Directory(Paths.document, THUMB_DIR);
    if (!dir.exists) dir.create();
    const dest = new File(dir, `${mealId}.jpg`);
    if (dest.exists) return dest.uri;
    await new File(sourceUri).copy(dest);
    return dest.uri;
  } catch {
    return null;
  }
}
