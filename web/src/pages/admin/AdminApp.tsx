import { Route, Routes } from "react-router-dom";
import { RequireAdmin } from "../../components/RequireAdmin";
import { AdminAnnouncementsPage } from "./AdminAnnouncementsPage";
import { AdminAuditPage } from "./AdminAuditPage";
import { AdminBillingPage } from "./AdminBillingPage";
import { AdminCreatorsPage } from "./AdminCreatorsPage";
import { AdminErrorsPage } from "./AdminErrorsPage";
import { AdminGamesPage } from "./AdminGamesPage";
import { AdminLayout } from "./AdminLayout";
import { AdminOverviewPage } from "./AdminOverviewPage";
import { AdminRolesPage } from "./AdminRolesPage";
import { AdminStaffPage } from "./AdminStaffPage";
import { AdminStoragePage } from "./AdminStoragePage";
import { AdminUsersPage } from "./AdminUsersPage";
import { AdminWaitlistPage } from "./AdminWaitlistPage";
import { LibraryHome, LibraryShell } from "./LibraryShell";
import { PeopleHome, PeopleShell } from "./PeopleShell";
import { AnalyticsAcquisitionPage } from "./analytics/AnalyticsAcquisitionPage";
import { AnalyticsClipsPage } from "./analytics/AnalyticsClipsPage";
import { AnalyticsDownloadsPage } from "./analytics/AnalyticsDownloadsPage";
import { AnalyticsFeaturesPage } from "./analytics/AnalyticsFeaturesPage";
import { AnalyticsFoldersPage } from "./analytics/AnalyticsFoldersPage";
import { AnalyticsGamesPage } from "./analytics/AnalyticsGamesPage";
import { AnalyticsGrowthPage } from "./analytics/AnalyticsGrowthPage";
import { AnalyticsHealthPage } from "./analytics/AnalyticsHealthPage";
import { AnalyticsHub } from "./analytics/AnalyticsHub";
import { AnalyticsInfrastructurePage } from "./analytics/AnalyticsInfrastructurePage";
import { AnalyticsLivePage } from "./analytics/AnalyticsLivePage";
import { AnalyticsOverviewPage } from "./analytics/AnalyticsOverviewPage";
import { AnalyticsRedirect, AnalyticsSectionShell } from "./analytics/AnalyticsSectionShell";
import { AnalyticsReportDetailPage } from "./analytics/AnalyticsReportDetailPage";
import { AnalyticsReportsPage } from "./analytics/AnalyticsReportsPage";
import { AnalyticsRetentionPage } from "./analytics/AnalyticsRetentionPage";
import { AnalyticsRevenuePage } from "./analytics/AnalyticsRevenuePage";
import { AnalyticsSharingPage } from "./analytics/AnalyticsSharingPage";
import { AnalyticsTrafficPage } from "./analytics/AnalyticsTrafficPage";
import { AnalyticsUsersPage } from "./analytics/AnalyticsUsersPage";
import { analyticsLegacyRedirects } from "./analytics/analyticsNav";

export function AdminApp() {
  return (
    <Routes>
      <Route
        element={
          <RequireAdmin>
            <AdminLayout />
          </RequireAdmin>
        }
      >
        <Route index element={<AdminOverviewPage />} />
        <Route path="people" element={<PeopleShell />}>
          <Route index element={<PeopleHome />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="users/:userId" element={<AnalyticsUsersPage />} />
          <Route path="waitlist" element={<AdminWaitlistPage />} />
          <Route path="creators" element={<AdminCreatorsPage />} />
        </Route>
        <Route path="library" element={<LibraryShell />}>
          <Route index element={<LibraryHome />} />
          <Route path="storage" element={<AdminStoragePage />} />
        </Route>
        <Route path="users" element={<AnalyticsRedirect to="/admin/people/users" />} />
        <Route path="waitlist" element={<AnalyticsRedirect to="/admin/people/waitlist" />} />
        <Route path="creators" element={<AnalyticsRedirect to="/admin/people/creators" />} />
        <Route path="clips" element={<AnalyticsRedirect to="/admin/library" />} />
        <Route path="storage" element={<AnalyticsRedirect to="/admin/library/storage" />} />
        <Route path="billing" element={<AdminBillingPage />} />
        <Route path="announcements" element={<AdminAnnouncementsPage />} />
        <Route path="errors" element={<AdminErrorsPage />} />
        <Route path="games" element={<AdminGamesPage />} />
        <Route path="analytics" element={<AnalyticsHub />}>
          <Route index element={<AnalyticsOverviewPage />} />
          <Route path="reports" element={<AnalyticsReportsPage />} />
          <Route path="reports/:id" element={<AnalyticsReportDetailPage />} />
          <Route path="growth" element={<AnalyticsSectionShell sectionId="growth" />}>
            <Route index element={<AnalyticsGrowthPage />} />
            <Route path="acquisition" element={<AnalyticsAcquisitionPage />} />
            <Route path="retention" element={<AnalyticsRetentionPage />} />
            <Route path="downloads" element={<AnalyticsDownloadsPage />} />
          </Route>
          <Route path="product" element={<AnalyticsSectionShell sectionId="product" />}>
            <Route index element={<AnalyticsRedirect to="/admin/analytics/product/clips" />} />
            <Route path="clips" element={<AnalyticsClipsPage />} />
            <Route path="games" element={<AnalyticsGamesPage />} />
            <Route path="features" element={<AnalyticsFeaturesPage />} />
            <Route path="folders" element={<AnalyticsFoldersPage />} />
            <Route path="sharing" element={<AnalyticsSharingPage />} />
            <Route path="users" element={<AnalyticsRedirect to="/admin/people/users" />} />
          </Route>
          <Route path="business" element={<AnalyticsSectionShell sectionId="business" />}>
            <Route index element={<AnalyticsRedirect to="/admin/analytics/business/revenue" />} />
            <Route path="revenue" element={<AnalyticsRevenuePage />} />
            <Route path="infrastructure" element={<AnalyticsInfrastructurePage />} />
          </Route>
          <Route path="health" element={<AnalyticsSectionShell sectionId="health" />}>
            <Route index element={<AnalyticsHealthPage />} />
            <Route path="live" element={<AnalyticsLivePage />} />
            <Route path="traffic" element={<AnalyticsTrafficPage />} />
          </Route>
          <Route path="health/errors" element={<AnalyticsRedirect to="/admin/errors" />} />
        </Route>
        {analyticsLegacyRedirects.map((item) => (
          <Route key={item.from} path={item.from} element={<AnalyticsRedirect to={item.to} />} />
        ))}
        <Route path="staff" element={<AdminStaffPage />} />
        <Route path="roles" element={<AdminRolesPage />} />
        <Route path="audit" element={<AdminAuditPage />} />
      </Route>
    </Routes>
  );
}
