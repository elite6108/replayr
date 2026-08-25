import { create } from "zustand";
import { fetchBillingStatus, type BillingStatus } from "../services/billing";
import { useSettingsStore } from "./settingsStore";

interface BillingState {
  status: BillingStatus | null;
  error: string | null;
  load: (accessToken: string | null) => Promise<void>;
}

export const useBillingStore = create<BillingState>((set) => ({
  status: null,
  error: null,
  load: async (accessToken) => {
    if (!accessToken) {
      set({ status: null, error: null });
      const settings = useSettingsStore.getState();
      if (settings.loaded && !settings.settings.watermarkExports) {
        void settings.update("watermarkExports", true).catch(() => undefined);
      }
      return;
    }
    try {
      const status = await fetchBillingStatus(accessToken);
      set({ status, error: null });
      const settings = useSettingsStore.getState();
      if (settings.loaded && settings.settings.watermarkExports !== status.watermark) {
        void settings.update("watermarkExports", status.watermark).catch(() => undefined);
      }
    } catch (caught) {
      set({ error: caught instanceof Error ? caught.message : "Could not load billing." });
    }
  },
}));
