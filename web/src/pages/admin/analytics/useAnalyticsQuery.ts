import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

const PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_week", label: "This Week" },
  { id: "last_week", label: "Last Week" },
  { id: "last_7", label: "Last 7 Days" },
  { id: "last_14", label: "Last 14 Days" },
  { id: "last_30", label: "Last 30 Days" },
  { id: "last_90", label: "Last 90 Days" },
  { id: "this_month", label: "This Month" },
  { id: "last_month", label: "Last Month" },
  { id: "ytd", label: "Year to Date" },
  { id: "all_time", label: "All Time" },
  { id: "custom", label: "Custom" },
] as const;

export function useAnalyticsQuery() {
  const [params, setParams] = useSearchParams();
  const range = params.get("range") || "last_30";
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const granularity = params.get("granularity") || "";
  const compare = params.get("compare") !== "0";
  const tz = params.get("tz") || "America/New_York";
  const cohort = params.get("cohort") || "signup";

  const patch = useCallback(
    (next: Record<string, string | null>) => {
      const copy = new URLSearchParams(params);
      for (const [key, value] of Object.entries(next)) {
        if (!value) copy.delete(key);
        else copy.set(key, value);
      }
      setParams(copy, { replace: true });
    },
    [params, setParams],
  );

  return {
    presets: PRESETS,
    range,
    from,
    to,
    granularity,
    compare,
    tz,
    cohort,
    search: useMemo(() => {
      const copy = new URLSearchParams();
      copy.set("range", range);
      if (range === "custom" && from) copy.set("from", from);
      if (range === "custom" && to) copy.set("to", to);
      if (granularity) copy.set("granularity", granularity);
      copy.set("compare", compare ? "1" : "0");
      copy.set("tz", tz);
      if (cohort && cohort !== "signup") copy.set("cohort", cohort);
      return `?${copy.toString()}`;
    }, [range, from, to, granularity, compare, tz, cohort]),
    setRange: (value: string) => patch({ range: value }),
    setCustom: (start: string, end: string) => patch({ range: "custom", from: start, to: end }),
    setGranularity: (value: string) => patch({ granularity: value || null }),
    setCompare: (value: boolean) => patch({ compare: value ? "1" : "0" }),
    setCohort: (value: string) => patch({ cohort: value === "signup" ? null : value }),
  };
}
