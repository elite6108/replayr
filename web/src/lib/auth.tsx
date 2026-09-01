import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { associateWebAcquisition, captureWebAttribution } from "./attribution";
import { getSupabase, supabaseConfigured } from "./supabase";

interface AuthValue {
  session: Session | null | undefined;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue>({
  session: undefined,
  signOut: async () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    if (!supabaseConfigured()) {
      setSession(null);
      return;
    }
    const supabase = getSupabase();
    void hydrateSession().then(setSession).catch(() => setSession(null));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!next) {
        setSession(null);
        return;
      }
      captureWebAttribution();
      associateWebAcquisition(next.access_token);
      void mergeRemoteUser(next).then(setSession);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      session,
      signOut: async () => {
        if (!supabaseConfigured()) return;
        await getSupabase().auth.signOut();
        setSession(null);
      },
    }),
    [session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  return useContext(AuthContext);
}

async function hydrateSession() {
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  if (!data.session) return null;
  try {
    const refreshed = await supabase.auth.refreshSession();
    return mergeRemoteUser(refreshed.data.session ?? data.session);
  } catch {
    return mergeRemoteUser(data.session);
  }
}

async function mergeRemoteUser(session: Session) {
  try {
    const { data } = await getSupabase().auth.getUser();
    return data.user ? { ...session, user: data.user } : session;
  } catch {
    return session;
  }
}
