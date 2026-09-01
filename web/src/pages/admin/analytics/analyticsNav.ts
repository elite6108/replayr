export type AnalyticsTab = {
  id: string;
  label: string;
  path: string;
  end?: boolean;
};

export type AnalyticsSection = {
  id: "growth" | "product" | "business" | "health";
  label: string;
  description: string;
  path: string;
  tabs: AnalyticsTab[];
};

export type AnalyticsSidebarItem = {
  id: string;
  label: string;
  to: string;
  end?: boolean;
};

export const analyticsSections: AnalyticsSection[] = [
  {
    id: "growth",
    label: "Growth",
    description: "Understand acquisition, activation, and retention.",
    path: "/admin/analytics/growth",
    tabs: [
      { id: "overview", label: "Overview", path: "/admin/analytics/growth", end: true },
      { id: "acquisition", label: "Acquisition", path: "/admin/analytics/growth/acquisition" },
      { id: "retention", label: "Retention", path: "/admin/analytics/growth/retention" },
      { id: "downloads", label: "Downloads", path: "/admin/analytics/growth/downloads" },
    ],
  },
  {
    id: "product",
    label: "Product",
    description: "See how players use Replayr.",
    path: "/admin/analytics/product",
    tabs: [
      { id: "clips", label: "Clips", path: "/admin/analytics/product/clips" },
      { id: "games", label: "Games", path: "/admin/analytics/product/games" },
      { id: "features", label: "Features", path: "/admin/analytics/product/features" },
      { id: "folders", label: "Folders", path: "/admin/analytics/product/folders" },
      { id: "sharing", label: "Sharing", path: "/admin/analytics/product/sharing" },
    ],
  },
  {
    id: "business",
    label: "Business",
    description: "Track subscriptions and infrastructure economics.",
    path: "/admin/analytics/business",
    tabs: [
      { id: "revenue", label: "Revenue", path: "/admin/analytics/business/revenue" },
      { id: "infrastructure", label: "Infrastructure", path: "/admin/analytics/business/infrastructure" },
    ],
  },
  {
    id: "health",
    label: "Health",
    description: "Monitor product reliability and releases.",
    path: "/admin/analytics/health",
    tabs: [
      { id: "product-health", label: "Product Health", path: "/admin/analytics/health", end: true },
      { id: "errors", label: "Errors", path: "/admin/analytics/health/errors" },
    ],
  },
];

export const analyticsSidebarItems: AnalyticsSidebarItem[] = [
  { id: "overview", label: "Overview", to: "/admin/analytics", end: true },
  { id: "growth", label: "Growth", to: "/admin/analytics/growth" },
  { id: "product", label: "Product", to: "/admin/analytics/product" },
  { id: "business", label: "Business", to: "/admin/analytics/business" },
  { id: "health", label: "Health", to: "/admin/analytics/health" },
  { id: "reports", label: "Reports", to: "/admin/analytics/reports" },
];

/** Bookmarked topic URLs → nested section paths. Search params are preserved at redirect time. */
export const analyticsLegacyRedirects: Array<{ from: string; to: string }> = [
  { from: "analytics/acquisition", to: "/admin/analytics/growth/acquisition" },
  { from: "analytics/retention", to: "/admin/analytics/growth/retention" },
  { from: "analytics/downloads", to: "/admin/analytics/growth/downloads" },
  { from: "analytics/clips", to: "/admin/analytics/product/clips" },
  { from: "analytics/games", to: "/admin/analytics/product/games" },
  { from: "analytics/features", to: "/admin/analytics/product/features" },
  { from: "analytics/folders", to: "/admin/analytics/product/folders" },
  { from: "analytics/sharing", to: "/admin/analytics/product/sharing" },
  { from: "analytics/revenue", to: "/admin/analytics/business/revenue" },
  { from: "analytics/infrastructure", to: "/admin/analytics/business/infrastructure" },
];

export function analyticsSectionById(id: AnalyticsSection["id"]): AnalyticsSection {
  const section = analyticsSections.find((item) => item.id === id);
  if (!section) throw new Error(`Unknown analytics section: ${id}`);
  return section;
}
