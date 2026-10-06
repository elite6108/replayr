import { analyticsTopTabs } from "./analyticsNav";
import { AdminSectionShell } from "../components/AdminSectionShell";

export function AnalyticsHub() {
  return <AdminSectionShell label="Analytics" tabs={analyticsTopTabs} />;
}
