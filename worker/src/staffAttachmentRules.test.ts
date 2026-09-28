import { describe, expect, it } from "vitest";
import { assertAllowedAttachment, avatarKey, isOwnedAvatarKey, sniffAvatarMime } from "./staffAttachmentRules";

describe("assertAllowedAttachment", () => {
  it("accepts a png image", () => {
    const allowed = assertAllowedAttachment({ filename: "shot.png", mime: "image/png", bytes: 1200 });
    expect(allowed.ext).toBe("png");
  });

  it("rejects executables even with a fake mime", () => {
    expect(() => assertAllowedAttachment({ filename: "setup.exe", mime: "image/png", bytes: 12 })).toThrow(/not allowed|do not match/);
  });

  it("rejects mime/extension mismatch", () => {
    expect(() => assertAllowedAttachment({ filename: "notes.pdf", mime: "image/png", bytes: 12 })).toThrow(/do not match/);
  });
});

describe("sniffAvatarMime", () => {
  it("reads jpeg magic", () => {
    expect(sniffAvatarMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer)).toBe("image/jpeg");
  });

  it("rejects empty bytes", () => {
    expect(sniffAvatarMime(new ArrayBuffer(0))).toBeNull();
  });
});

describe("avatar keys", () => {
  const user = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const objectId = "11111111-2222-3333-4444-555555555555";
  it("owns only the caller prefix", () => {
    const key = avatarKey(user, objectId, "png");
    expect(isOwnedAvatarKey(user, key)).toBe(true);
    expect(isOwnedAvatarKey("bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", key)).toBe(false);
    expect(isOwnedAvatarKey(user, `avatars/${user}/../x.png`)).toBe(false);
  });
});
