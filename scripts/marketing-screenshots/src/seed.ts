import type { Session, User } from "@supabase/supabase-js";
import { useAuthStore } from "../../../src/stores/authStore";
import { useBillingStore } from "../../../src/stores/billingStore";
import { useRecordingStore } from "../../../src/stores/recordingStore";
import { marketingReplay } from "./demo-data";

const USER_ID = "00000000-0000-4000-8000-000000000001";

function demoUser(): User {
  return {
    id: USER_ID,
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-01-01T00:00:00.000Z",
  } as User;
}

function demoSession(user: User): Session {
  return {
    access_token: "marketing",
    refresh_token: "",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user,
  } as Session;
}

/** Signed-in shell without a real JWT or Supabase client. Token never rendered. */
export function seedMarketingSession() {
  const user = demoUser();
  useAuthStore.setState({
    configured: true,
    ready: true,
    user,
    session: demoSession(user),
    profile: {
      id: USER_ID,
      username: "you",
      display_name: "You",
      avatar_url: null,
      bio: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      is_verified: false,
      is_private: false,
      followers_count: 12,
      following_count: 8,
      clip_count: 6,
    },
    storage: {
      user_id: USER_ID,
      storage_used_bytes: 1_240_000_000,
      storage_limit_bytes: 5_368_709_120,
      updated_at: "2026-09-15T00:00:00.000Z",
    },
    error: null,
  });
  useBillingStore.setState({
    status: {
      plan: "free",
      status: "active",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      complimentary: false,
      watermark: true,
      ads: false,
      storageUsedBytes: 1_240_000_000,
      storageLimitBytes: 5_368_709_120,
      maxClipDurationMs: null,
      maxUploadQuality: null,
      premium: false,
    },
    error: null,
  });
  useRecordingStore.setState({
    replay: marketingReplay(),
    status: useRecordingStore.getState().status,
    busy: false,
  });
}
