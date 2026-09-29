import { describe, expect, it } from "vitest";
import { socialPushCopy } from "./socialPush";

describe("socialPushCopy", () => {
  it("uses actor name and a generic action", () => {
    expect(socialPushCopy("clip_like", "Alex")).toEqual({ title: "Alex", body: "liked your clip" });
    expect(socialPushCopy("clip_comment", "Alex")).toEqual({ title: "Alex", body: "commented on your clip" });
    expect(socialPushCopy("message", "Alex")).toEqual({ title: "Alex", body: "sent you a message" });
  });

  it("skips kinds that are not social lock-screen events", () => {
    expect(socialPushCopy("follow_request", "Alex")).toBeNull();
  });
});
