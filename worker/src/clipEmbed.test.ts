import { describe, expect, it } from "vitest";
import { injectHead } from "./screenshotsCore";
import { clipEmbedTitle, clipHeadTags, posterPayload } from "./clipEmbed";

const SHELL = `<html><head><meta name="description" content="The play already happened. Replayr keeps Instant Replay rolling on Windows, saves the clip on this PC, and shares a quiet unlisted link — no username in the URL." /><title>Replayr</title></head><body></body></html>`;

describe("clip embeds", () => {
  it("replaces the marketing description with the clip title and a same-origin video", () => {
    const html = injectHead(
      SHELL,
      clipHeadTags({
        origin: "https://replayr.tv",
        slug: "jovtcwepr8",
        title: "Clutch round",
        width: 1920,
        height: 1080,
        bytes: 8_000_000,
        hasPoster: true,
        found: true,
      }),
    );
    expect(html).not.toMatch(/The play already happened/);
    expect(html).not.toContain("<title>Replayr</title>");
    expect(html).toContain("<title>Clutch round · Replayr</title>");
    expect(html).toContain('property="og:video" content="https://replayr.tv/c/jovtcwepr8/video.mp4"');
    expect(html).toContain('property="og:video:type" content="video/mp4"');
    expect(html).toContain('property="og:image" content="https://replayr.tv/c/jovtcwepr8/poster"');
    expect(html).toContain('property="og:video:width" content="1920"');
    expect(html).not.toContain("r2.cloudflarestorage.com");
  });

  it("escapes a title so it cannot break out of the meta attribute", () => {
    const html = clipHeadTags({
      origin: "https://replayr.tv",
      slug: "jovtcwepr8",
      title: `"><script>alert(1)</script>`,
      width: null,
      height: null,
        bytes: 1_000_000,
        hasPoster: false,
        found: true,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).not.toContain("og:image");
  });

  it("omits video when the clip is missing or private", () => {
    const html = injectHead(
      SHELL,
      clipHeadTags({
        origin: "https://replayr.tv",
        slug: "jovtcwepr8",
        title: "Secret",
        width: 1280,
        height: 720,
        bytes: 1,
        hasPoster: true,
        found: false,
      }),
    );
    expect(html).not.toContain("og:video");
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("Secret");
    expect(html).toContain("This clip is no longer available.");
  });

  it("collapses an empty title", () => {
    expect(clipEmbedTitle("  \n  ")).toBe("Clip · Replayr");
    expect(clipEmbedTitle("a".repeat(200)).length).toBeLessThanOrEqual(" · Replayr".length + 80);
  });

  it("turns a 32-bit BMP thumb into a PNG Discord can show", async () => {
    const png = await posterPayload(sampleBmp(2, 1));
    expect(png?.contentType).toBe("image/png");
    expect(Array.from(png?.body.subarray(0, 4) ?? [])).toEqual([137, 80, 78, 71]);
  });

  it("keeps a clip Discord cannot inline as an image card", () => {
    const html = clipHeadTags({
      origin: "https://replayr.tv",
      slug: "jovtcwepr8",
      title: "Long capture",
      width: 1920,
      height: 1080,
      bytes: 600_000_000,
      hasPoster: true,
      found: true,
    });
    expect(html).toContain("Long capture · Replayr");
    expect(html).toContain('property="og:image"');
    expect(html).not.toContain("og:video");
    const unknown = clipHeadTags({
      origin: "https://replayr.tv",
      slug: "jovtcwepr8",
      title: "Long capture",
      width: 1920,
      height: 1080,
      bytes: null,
      hasPoster: true,
      found: true,
    });
    expect(unknown).not.toContain("og:video");
  });
});

function sampleBmp(width: number, height: number): Uint8Array {
  const rowStride = Math.ceil((width * 4) / 4) * 4;
  const pixelBytes = rowStride * height;
  const bytes = new Uint8Array(54 + pixelBytes);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  const view = new DataView(bytes.buffer);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  bytes[54] = 20;
  bytes[55] = 40;
  bytes[56] = 60;
  bytes[57] = 255;
  return bytes;
}
