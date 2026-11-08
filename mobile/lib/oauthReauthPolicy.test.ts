import assert from "node:assert/strict";
import { test } from "node:test";
import { assertProviderPromptCompleted, providerPromptCompleted } from "./oauthReauthPolicy.ts";

test("a dismissed provider window never reaches account deletion", () => {
  assert.equal(providerPromptCompleted("cancel"), false);
  assert.equal(providerPromptCompleted("dismiss"), false);
  assert.equal(providerPromptCompleted("success"), true);
  assert.throws(() => assertProviderPromptCompleted("cancel"), /Sign in with your provider again/);
  assert.throws(() => assertProviderPromptCompleted("dismiss"), /Sign in with your provider again/);
  assert.doesNotThrow(() => assertProviderPromptCompleted("success"));
});
