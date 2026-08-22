import type { Session, User } from "@supabase/supabase-js";
import { create } from "zustand";
import {
  fetchOwnProfile,
  fetchOwnStorage,
  getSupabase,
  supabaseConfigured,
  updateOwnProfile,
} from "../services/supabase";
import type { Profile, UserStorage } from "../types/profile";
import { authErrorMessage, normalizeAuthEmail, validateAuthCredentials } from "../utils/auth";

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
  signOut: () => Promise<void>;
  saveProfile: (patch: Partial<Pick<Profile, "username" | "display_name" | "bio">>) => Promise<void>;
  refreshProfile: () => Promise<void>;
}

async function loadUserData(userId: string) {
  const [profile, storage] = await Promise.all([
    fetchOwnProfile(userId),
    fetchOwnStorage(userId),
  ]);
  return { profile, storage };
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
    try {
    const supabase = getSupabase();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const extra = session?.user ? await loadUserData(session.user.id) : { profile: null, storage: null };
    set({
      configured: true,
      ready: true,
      session,
      user: session?.user ?? null,
      error: null,
      ...extra,
    });
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
            error: caught instanceof Error ? caught.message : "Signed in, but the profile could not load.",
          });
        }
      })();
    });
    } catch (caught) {
      set({
        ready: true,
        configured: true,
        error: caught instanceof Error ? caught.message : "Could not initialize auth",
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
      set({ error: caught instanceof Error ? caught.message : "Could not load profile" });
    }
  },
}));
