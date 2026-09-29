import { describe, expect, it } from "vitest";
import { isExpoPushToken } from "./push";

describe("isExpoPushToken", () => {
  it("accepts Expo token format", () => {
    expect(isExpoPushToken("ExponentPushToken[AbC123-xyz]")).toBe(true);
  });

  it("rejects empty and APNs-looking values", () => {
    expect(isExpoPushToken("")).toBe(false);
    expect(isExpoPushToken("not-a-token")).toBe(false);
  });
});
