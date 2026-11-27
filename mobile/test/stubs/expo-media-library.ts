export const MediaType = { IMAGE: "image" };
export const MediaSubtype = { SCREENSHOT: "screenshot" };
export const PermissionStatus = { UNDETERMINED: "undetermined", GRANTED: "granted", DENIED: "denied" };
export const AssetField = { MEDIA_TYPE: "mediaType", CREATION_TIME: "creationTime" };
export class Query {
  eq() { return this; }
  orderBy() { return this; }
  limit() { return this; }
  offset() { return this; }
  async exeForMetadata() { return []; }
}
export class Asset {
  constructor(public id: string) {}
  async getUri() { return this.id; }
}
export async function getPermissionsAsync() {
  return { granted: false, status: PermissionStatus.DENIED, accessPrivileges: "none", canAskAgain: true };
}
export async function requestPermissionsAsync() {
  return getPermissionsAsync();
}
