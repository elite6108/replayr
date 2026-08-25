import type { Session, User } from "@supabase/supabase-js";
import { create } from "zustand";
import { publicSiteUrl } from "../branding";
import {
  fetchOwnProfile,
  fetchOwnStorage,
  getSupabase,
  supabaseConfigured,
  updateOwnProfile,
} from "../services/supabase";
import type { Profile, UserStorage } from "../types/profile";
import { authErrorMessage, normalizeAuthEmail, validateAuthCredentials } from "../utils/auth";

export type SocialProvider = "google" | "discord" | "twitter";

interface AuthState {
  configured: boolean;
  ready: boolean;
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  storage: UserStorage | null;
  error: string | null;
  initialize: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signInWithProvider: (provider: SocialProvider) => Promise<void>;
  completeOAuthFromUrl: (url: string) => Promise<void>;
  signOut: () => Promise<void>;
  saveProfile: (patch: Partial<Pick<Profile, "username" | "display_name" | "bio">>) => Promise<void>;
  refreshProfile: () => Promise<void>;
}

let deepLinkListening = false;
let authListenerAttached = false;

async function loadUserData(userId: string) {
  const [profile, storage] = await Promise.all([
    fetchOwnProfile(userId),
    fetchOwnStorage(userId),
  ]);
  return { profile, storage };
}

function attachAuthListeners(
  get: () => AuthState,
  set: (
    partial:
      | Partial<AuthState>
      | ((state: AuthState) => Partial<AuthState>),
  ) => void,
  supabase: ReturnType<typeof getSupabase>,
) {
  if (!authListenerAttached) {
    authListenerAttached = true;
    supabase.auth.onAuthStateChange((_event, nextSession) => {
      void (async () => {
        try {
          const nextExtra = nextSession?.user
            ? await loadUserData(nextSession.user.id)
            : { profile: null, storage: null };
          set({
            session: nextSession,
            user: nextSession?.user ?? null,
            error: null,
            ...nextExtra,
          });
        } catch (caught) {
          set({
            session: nextSession,
            user: nextSession?.user ?? null,
            error: authErrorMessage(caught, "Signed in, but the profile could not load."),
          });
        }
      })();
    });
  }
  if (!deepLinkListening) {
    deepLinkListening = true;
    void listenForOAuthReturn((url) => {
      if (url.startsWith("replayr://billing")) {
        void import("./billingStore").then(({ useBillingStore }) =>
          useBillingStore.getState().load(get().session?.access_token ?? null),
        );
        return;
      }
      void get().completeOAuthFromUrl(url);
    });
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  configured: supabaseConfigured(),
  ready: !supabaseConfigured(),
  session: null,
  user: null,
  profile: null,
  storage: null,
  error: null,
  initialize: async () => {
    if (!supabaseConfigured()) {
      set({ ready: true, configured: false });
      return;
    }
    const supabase = getSupabase();
    attachAuthListeners(get, set, supabase);
    try {
      const session = await withTimeout(hydrateSession(), 8000, "Auth session");
      const extra = session?.user
        ? await withTimeout(loadUserData(session.user.id), 8000, "Auth profile").catch((caught) => {
            console.warn("auth profile restore", caught);
            return { profile: null, storage: null };
          })
        : { profile: null, storage: null };
      set((state) => ({
        configured: true,
        ready: true,
        error: null,
        ...(state.session && !session
          ? {}
          : {
              session,
              user: session?.user ?? null,
              ...extra,
            }),
      }));
    } catch (caught) {
      console.warn("auth initialize", caught);
      set({
        ready: true,
        configured: true,
      });
    }
  },
  signIn: async (email, password) => {
    set({ error: null });
    const invalid = validateAuthCredentials(email, password);
    if (invalid) {
      set({ error: invalid });
      throw new Error(invalid);
    }
    try {
      const { data, error } = await getSupabase().auth.signInWithPassword({
        email: normalizeAuthEmail(email),
        password,
      });
      if (error) {
        const message = authErrorMessage(error, "Could not sign in");
        set({ error: message });
        throw new Error(message);
      }
      if (!data.session) {
        const message = "Sign-in did not return a session. Confirm the email, then try again.";
        set({ error: message });
        throw new Error(message);
      }
      set({ session: data.session, user: data.session.user, error: null });
      await get().refreshProfile();
    } catch (caught) {
      if (get().error) throw caught instanceof Error ? caught : new Error(String(caught));
      const message = authErrorMessage(caught, "Could not sign in");
      set({ error: message });
      throw new Error(message);
    }
  },
  signUp: async (email, password) => {
    set({ error: null });
    const invalid = validateAuthCredentials(email, password);
    if (invalid) {
      set({ error: invalid });
      throw new Error(invalid);
    }
    try {
      const { data, error } = await getSupabase().auth.signUp({
        email: normalizeAuthEmail(email),
        password,
      });
      if (error) {
        const message = authErrorMessage(error, "Could not create account");
        set({ error: message });
        throw new Error(message);
      }
      if (!data.session) {
        const message = "Account created. Confirm the email, then sign in.";
        set({ error: message });
        throw new Error(message);
      }
      set({ session: data.session, user: data.session.user, error: null });
      await get().refreshProfile();
    } catch (caught) {
      if (get().error) throw caught instanceof Error ? caught : new Error(String(caught));
      const message = authErrorMessage(caught, "Could not create account");
      set({ error: message });
      throw new Error(message);
    }
  },
  signInWithProvider: async (provider) => {
    set({ error: null });
    try {
      const { data, error } = await getSupabase().auth.signInWithOAuth({
        provider,
        options: {
          skipBrowserRedirect: true,
          redirectTo: `${publicSiteUrl()}/auth/desktop`,
        },
      });
      if (error || !data.url) {
        const message = authErrorMessage(error, "Could not start social sign-in");
        set({ error: message });
        throw new Error(message);
      }
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(data.url);
    } catch (caught) {
      if (get().error) throw caught instanceof Error ? caught : new Error(String(caught));
      const message = authErrorMessage(caught, "Could not start social sign-in");
      set({ error: message });
      throw new Error(message);
    }
  },
  completeOAuthFromUrl: async (url) => {
    try {
      const parsed = new URL(url);
      const code = parsed.searchParams.get("code");
      const denied = parsed.searchParams.get("error_description") || parsed.searchParams.get("error");
      if (denied) {
        set({ error: denied });
        return;
      }
      if (!code) return;
      const { data, error } = await getSupabase().auth.exchangeCodeForSession(code);
      if (error || !data.session) {
        const message = authErrorMessage(error, "Could not finish social sign-in");
        set({ error: message });
        return;
      }
      set({ session: data.session, user: data.session.user, error: null });
      await get().refreshProfile();
      const { useToastStore } = await import("./toastStore");
      useToastStore.getState().show("Signed in");
    } catch (caught) {
      set({ error: authErrorMessage(caught, "Could not finish social sign-in") });
    }
  },
  signOut: async () => {
    await getSupabase().auth.signOut();
    set({ session: null, user: null, profile: null, storage: null, error: null });
  },
  saveProfile: async (patch) => {
    const user = get().user;
    if (!user) throw new Error("Not signed in.");
    const profile = await updateOwnProfile(user.id, patch);
    set({ profile });
  },
  refreshProfile: async () => {
    try {
      const user = get().user ?? (await getSupabase().auth.getUser()).data.user;
      if (!user) return;
      const extra = await loadUserData(user.id);
      set({ user, error: null, ...extra });
    } catch (caught) {
      set({ error: authErrorMessage(caught, "Could not load profile") });
    }
  },
}));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function hydrateSession() {
  const { data, error } = await getSupabase().auth.getSession();
  if (error) throw error;
  return data.session ?? null;
}

async function listenForOAuthReturn(onUrl: (url: string) => void) {
  const handle = (url: string) => {
    if (url.startsWith("replayr://")) onUrl(url);
  };
  try {
    const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
    const current = await getCurrent();
    for (const url of current ?? []) handle(url);
    await onOpenUrl((urls) => {
      for (const url of urls) handle(url);
    });
  } catch {
    /* plugin missing in tests */
  }
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string[]>("oauth-callback-url", (event) => {
      for (const url of event.payload) handle(url);
    });
  } catch {
    /* keep going */
  }
}
