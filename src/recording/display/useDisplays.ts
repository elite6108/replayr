import { useEffect, useState } from "react";
import { listDisplays } from "../../services/tauri";
import type { DisplayInfo } from "./displayTypes";

export function useDisplays() {
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void listDisplays()
        .then((next) => {
          if (cancelled) return;
          const list = Array.isArray(next) ? next : [];
          setDisplays(list);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          const message = caught instanceof Error ? caught.message : "Could not list displays.";
          setError(message);
        });
    };
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return { displays, error };
}
