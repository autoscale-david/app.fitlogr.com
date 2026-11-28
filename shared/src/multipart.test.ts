import { describe, expect, it } from "vitest";
import { encodePhotoUpload } from "./multipart";

describe("photo upload encoding", () => {
  it("is read back by a standard multipart parser as a JSON field and a JPEG file", async () => {
    // Bytes that look like line breaks and dashes, to prove the image is not treated as text.
    const image = new Uint8Array([0xff, 0xd8, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0x00, 0x80, 0xff, 0xd9]);
    const metadata = { content_sha256: "abc", note: 'quotes " and unicode é', upload_to_google_photos: false };
    const upload = encodePhotoUpload(metadata, image);

    const request = new Request("https://example.test/upload", {
      method: "POST",
      headers: { "content-type": upload.contentType },
      body: upload.body,
    });
    const form = await request.formData();

    expect(JSON.parse(String(form.get("metadata")))).toEqual(metadata);
    const file = form.get("image");
    expect(file).toBeInstanceOf(File);
    expect((file as File).type).toBe("image/jpeg");
    expect((file as File).name).toBe("meal.jpg");
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(image);
  });

  it("uses a different boundary for every upload", () => {
    const first = encodePhotoUpload({}, new Uint8Array([1]));
    const second = encodePhotoUpload({}, new Uint8Array([1]));
    expect(first.contentType).not.toBe(second.contentType);
  });
});
