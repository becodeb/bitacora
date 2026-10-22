import { describe, expect, it } from "vitest";
import { classifyAttachmentMime } from "./mime.js";

describe("classifyAttachmentMime", () => {
  it.each(["image/jpeg", "image/png", "image/webp"])("accepts photo mime type %s", (mimeType) => {
    const result = classifyAttachmentMime(mimeType);
    expect(result?.kind).toBe("photo");
  });

  it.each(["audio/m4a", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"])(
    "accepts voice mime type %s",
    (mimeType) => {
      const result = classifyAttachmentMime(mimeType);
      expect(result?.kind).toBe("voice");
    },
  );

  it("is case-insensitive", () => {
    expect(classifyAttachmentMime("IMAGE/JPEG")?.kind).toBe("photo");
  });

  it("rejects an unlisted mime type", () => {
    expect(classifyAttachmentMime("application/pdf")).toBeNull();
  });

  it("rejects an empty mime type", () => {
    expect(classifyAttachmentMime("")).toBeNull();
  });

  it("gives photo and voice different size caps", () => {
    const photo = classifyAttachmentMime("image/jpeg");
    const voice = classifyAttachmentMime("audio/wav");

    expect(photo?.maxBytes).toBeGreaterThan(0);
    expect(voice?.maxBytes).toBeGreaterThan(0);
    expect(photo?.maxBytes).not.toBe(voice?.maxBytes);
  });
});
