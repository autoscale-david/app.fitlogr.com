import {
  Asset,
  AssetField,
  MediaSubtype,
  MediaType,
  PermissionStatus,
  Query,
  getPermissionsAsync,
  requestPermissionsAsync,
} from "expo-media-library";
import { timestampToDate } from "../dates";
import { prepareMealImage, type PreparedMealImage } from "./prepare";

/**
 * "limited" is iOS "Limited Access": the scan runs but only sees the photos the person hand-picked,
 * so new meal photos never show up. iOS reports it as granted, which is why it gets its own state.
 */
export type LibraryAccess = "full" | "limited" | "denied" | "undetermined";

export const LIMITED_ACCESS_NOTE =
  "fitlogr can only see the photos you selected. Allow access to all photos in iOS Settings so new meal photos are found automatically.";

/** Current photo-library access. With `ask`, shows the iOS prompt if the person has not decided yet. */
export async function libraryAccess(ask: boolean): Promise<LibraryAccess> {
  let permission = await getPermissionsAsync(false, ["photo"]);
  if (!permission.granted && ask) permission = await requestPermissionsAsync(false, ["photo"]);
  if (permission.granted) return permission.accessPrivileges === "limited" ? "limited" : "full";
  return permission.status === PermissionStatus.UNDETERMINED ? "undetermined" : "denied";
}

export interface LibraryPhoto {
  /** Stable library id: `ph://…` on iOS, a `content://` URI on Android. */
  id: string;
  captured: Date | null;
  screenshot: boolean;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 400;

/**
 * Walks the photo library newest first and stops at `since`. Reads only cheap metadata: no file is
 * resolved, decoded, or downloaded from iCloud until the caller decides to load a photo.
 * `visit` returns false to stop the walk.
 */
export async function walkLibraryPhotos(
  options: { since: number; signal?: AbortSignal },
  visit: (photo: LibraryPhoto) => Promise<boolean>,
): Promise<void> {
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (options.signal?.aborted) return;
    // The date window is checked in JS. A native creation-time predicate that disagrees on seconds
    // versus milliseconds matches no photos.
    const batch = await new Query()
      .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
      .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
      .limit(PAGE_SIZE)
      .offset(offset)
      .exeForMetadata();
    if (batch.length === 0) return;
    offset += batch.length;
    for (const item of batch) {
      if (options.signal?.aborted) return;
      const captured = timestampToDate(item.creationTime);
      if (captured && captured.getTime() < options.since) return;
      const screenshot = Boolean(item.mediaSubtypes?.includes(MediaSubtype.SCREENSHOT)) || /screenshot/i.test(item.filename ?? "");
      if (!(await visit({ id: item.id, captured, screenshot }))) return;
    }
  }
}

/**
 * Compresses one library photo for analysis. The library id loads a small copy directly (iOS fetches
 * it from iCloud at that size if needed), which avoids resolving the full-size original. If that
 * fails, the resolved file is tried before giving up.
 */
export async function prepareLibraryPhoto(id: string): Promise<PreparedMealImage> {
  try {
    return await prepareMealImage(id);
  } catch (first) {
    let uri: string;
    try {
      uri = await new Asset(id).getUri();
    } catch {
      throw first;
    }
    if (!uri || uri === id) throw first;
    return prepareMealImage(uri);
  }
}
