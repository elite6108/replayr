import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { useAuth } from "./auth";
import { fetchStaffMe, isStaffForbidden, type StaffMe, type StaffPermissionKey } from "./api.staff";

type StaffContextValue = {
  me: StaffMe | null;
  loading: boolean;
  denied: boolean;
  can: (key: StaffPermissionKey) => boolean;
  reload: () => void;
};

const StaffContext = createContext<StaffContextValue>({
  me: null,
  loading: false,
  denied: false,
  can: () => false,
  reload: () => undefined,
});

export function StaffPermissionsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const token = session?.access_token;
  const [me, setMe] = useState<StaffMe | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [denied, setDenied] = useState(false);
  const meRef = useRef<StaffMe | null>(null);
  meRef.current = me;

  const load = useCallback(() => {
    if (!token) {
      setMe(null);
      setDenied(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    void fetchStaffMe(token)
      .then((next) => {
        setMe(next);
        setDenied(false);
      })
      .catch((error) => {
        if (isStaffForbidden(error)) {
          setMe(null);
          setDenied(true);
          return;
        }
        if (!meRef.current) {
          setDenied(false);
        }
      })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") load();
    });
    return () => sub.remove();
  }, [load]);

  const value = useMemo<StaffContextValue>(() => {
    const permissions = new Set(me?.permissions ?? []);
    const all = Boolean(me?.isSuperAdmin || permissions.has("*"));
    return {
      me,
      loading,
      denied,
      can: (key) => all || permissions.has(key),
      reload: load,
    };
  }, [me, loading, denied, load]);

  return <StaffContext.Provider value={value}>{children}</StaffContext.Provider>;
}

export function useStaffPermissions() {
  return useContext(StaffContext);
}
