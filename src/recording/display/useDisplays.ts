import { useCallback, useEffect, useRef, useState } from "react";
import { listDisplays } from "../../services/tauri";
import type { DisplayInfo } from "./displayTypes";

export function useDisplays() {
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    void listDisplays()
      .then((next) => {
        if (!alive.current) return;
        const list = Array.isArray(next) ? next : [];
        setDisplays(list);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!alive.current) return;
        const message = caught instanceof Error ? caught.message : "Could not list displays.";
        setError(message);
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { displays, error, refresh };
}
