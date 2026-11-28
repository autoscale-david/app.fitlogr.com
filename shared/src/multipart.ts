/**
 * The body of the photo analysis upload, built by hand as bytes.
 *
 * The phone cannot use `FormData` with a `{ uri, name, type }` file part: Expo's `fetch` (the global
 * `fetch` from SDK 58 on) rejects that React Native shape before anything is sent. Raw bytes with an
 * explicit content type work in every fetch. The server test uses this same function, so what the
 * phone sends is what the server is tested against.
 */
export interface EncodedUpload {
  body: Uint8Array;
  contentType: string;
}

export function encodePhotoUpload(metadata: unknown, image: Uint8Array, boundary: string = uploadBoundary()): EncodedUpload {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="metadata"\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      // The filename is what makes the server read this part as a file.
      `Content-Disposition: form-data; name="image"; filename="meal.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + image.length + tail.length);
  body.set(head, 0);
  body.set(image, head.length);
  body.set(tail, head.length + image.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Long and random, so it cannot occur inside the JPEG by accident. */
function uploadBoundary(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let boundary = "----fitlogrUpload";
  for (let index = 0; index < 32; index += 1) boundary += chars.charAt(Math.floor(Math.random() * chars.length));
  return boundary;
}
