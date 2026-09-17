import { useCallback, useEffect } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";

export function useStaffPoll(load: () => void | Promise<void>) {
  useFocusEffect(
    useCallback(() => {
      void load();
      const timer = setInterval(() => void load(), 30_000);
      return () => clearInterval(timer);
    }, [load]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => sub.remove();
  }, [load]);
}
