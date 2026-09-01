import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import { RequireAuth } from "./components/RequireAuth";
import { RequireAdmin } from "./components/RequireAdmin";
import { AuthProvider } from "./lib/auth";
import { SocialUnreadProvider } from "./lib/socialUnread";
import { AccountPage } from "./pages/AccountPage";
import { ClipPage } from "./pages/ClipPage";
import { CreatorsPage } from "./pages/CreatorsPage";
import { ExplorePage } from "./pages/ExplorePage";
import { FeaturesPage } from "./pages/FeaturesPage";
import { FriendsPage } from "./pages/FriendsPage";
import { GamePage } from "./pages/GamePage";
import { GamesPage } from "./pages/GamesPage";
import { HomePage } from "./pages/HomePage";
import { LegalPage } from "./pages/LegalPage";
import { FolderPage } from "./pages/FolderPage";
import { FoldersPage } from "./pages/FoldersPage";
import { LibraryPage } from "./pages/LibraryPage";
import { MessagesPage } from "./pages/MessagesPage";
import { PricingPage } from "./pages/PricingPage";
import { PublicFolderPage } from "./pages/PublicFolderPage";
import { UserProfilePage } from "./pages/UserProfilePage";
import { AuthCallbackPage } from "./pages/AuthCallbackPage";
import { AuthDesktopPage } from "./pages/AuthDesktopPage";
import { SignInPage } from "./pages/SignInPage";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminOverviewPage } from "./pages/admin/AdminOverviewPage";
import { AdminUsersPage } from "./pages/admin/AdminUsersPage";
import { AdminBillingPage } from "./pages/admin/AdminBillingPage";
import { AdminClipsPage } from "./pages/admin/AdminClipsPage";
import { AdminStoragePage } from "./pages/admin/AdminStoragePage";
import { AdminCreatorsPage } from "./pages/admin/AdminCreatorsPage";
import { AdminErrorsPage } from "./pages/admin/AdminErrorsPage";
import { AdminAnnouncementsPage } from "./pages/admin/AdminAnnouncementsPage";
import { AnalyticsOverviewPage } from "./pages/admin/analytics/AnalyticsOverviewPage";
import { AnalyticsDownloadsPage } from "./pages/admin/analytics/AnalyticsDownloadsPage";
import { AnalyticsGrowthPage } from "./pages/admin/analytics/AnalyticsGrowthPage";
import { AnalyticsRetentionPage } from "./pages/admin/analytics/AnalyticsRetentionPage";
import { AnalyticsAcquisitionPage } from "./pages/admin/analytics/AnalyticsAcquisitionPage";
import { AnalyticsClipsPage } from "./pages/admin/analytics/AnalyticsClipsPage";
import { AnalyticsGamesPage } from "./pages/admin/analytics/AnalyticsGamesPage";
import { AnalyticsFeaturesPage } from "./pages/admin/analytics/AnalyticsFeaturesPage";
import { AnalyticsFoldersPage } from "./pages/admin/analytics/AnalyticsFoldersPage";
import { AnalyticsSharingPage } from "./pages/admin/analytics/AnalyticsSharingPage";
import { AnalyticsRevenuePage } from "./pages/admin/analytics/AnalyticsRevenuePage";
import { AnalyticsInfrastructurePage } from "./pages/admin/analytics/AnalyticsInfrastructurePage";
import { AnalyticsHealthPage } from "./pages/admin/analytics/AnalyticsHealthPage";
import { AnalyticsReportsPage } from "./pages/admin/analytics/AnalyticsReportsPage";
import { AnalyticsReportDetailPage } from "./pages/admin/analytics/AnalyticsReportDetailPage";
import { AnalyticsRedirect, AnalyticsSectionShell } from "./pages/admin/analytics/AnalyticsSectionShell";
import { analyticsLegacyRedirects } from "./pages/admin/analytics/analyticsNav";
import { AdminAuditPage } from "./pages/admin/AdminAuditPage";
import { AnnouncementHost } from "./components/AnnouncementHost";

export function App() {
  return (
    <AuthProvider>
      <SocialUnreadProvider>
        <AppShell />
      </SocialUnreadProvider>
    </AuthProvider>
  );
}

function AppShell() {
  const location = useLocation();
  const admin = location.pathname.startsWith("/admin");
  const messages = location.pathname.startsWith("/messages");
  const oauthCode =
    new URLSearchParams(location.search).get("code") ||
    new URLSearchParams(location.hash.replace(/^#/, "")).get("code");
  if (oauthCode && location.pathname === "/") {
    return <Navigate to={`/auth/desktop${location.search}${location.hash}`} replace />;
  }
  return (
      <div className={`site${admin ? " site-admin" : ""}${messages ? " site-messages" : ""}`}>
        <SiteHeader />
        <AnnouncementHost />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/creators" element={<CreatorsPage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/games/:slug" element={<GamePage />} />
          <Route path="/signin" element={<SignInPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/auth/desktop" element={<AuthDesktopPage />} />
          <Route path="/privacy" element={<LegalPage kind="privacy" />} />
          <Route path="/terms" element={<LegalPage kind="terms" />} />
          <Route
            path="/library"
            element={
              <RequireAuth>
                <LibraryPage />
              </RequireAuth>
            }
          />
          <Route
            path="/library/folders"
            element={
              <RequireAuth>
                <FoldersPage />
              </RequireAuth>
            }
          />
          <Route
            path="/folders/:folderId"
            element={
              <RequireAuth>
                <FolderPage />
              </RequireAuth>
            }
          />
          <Route
            path="/friends"
            element={
              <RequireAuth>
                <FriendsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/messages"
            element={
              <RequireAuth>
                <MessagesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/messages/:id"
            element={
              <RequireAuth>
                <MessagesPage />
              </RequireAuth>
            }
          />
          <Route path="/u/:username" element={<UserProfilePage />} />
          <Route
            path="/account"
            element={
              <RequireAuth>
                <AccountPage />
              </RequireAuth>
            }
          />
          <Route path="/c/:slug" element={<ClipPage />} />
          <Route path="/f/:token" element={<PublicFolderPage />} />
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminLayout />
              </RequireAdmin>
            }
          >
            <Route index element={<AdminOverviewPage />} />
            <Route path="users" element={<AdminUsersPage />} />
            <Route path="billing" element={<AdminBillingPage />} />
            <Route path="clips" element={<AdminClipsPage />} />
            <Route path="storage" element={<AdminStoragePage />} />
            <Route path="creators" element={<AdminCreatorsPage />} />
            <Route path="announcements" element={<AdminAnnouncementsPage />} />
            <Route path="errors" element={<AdminErrorsPage />} />
            <Route path="analytics" element={<AnalyticsOverviewPage />} />
            <Route path="analytics/reports" element={<AnalyticsReportsPage />} />
            <Route path="analytics/reports/:id" element={<AnalyticsReportDetailPage />} />
            <Route path="analytics/growth" element={<AnalyticsSectionShell sectionId="growth" />}>
              <Route index element={<AnalyticsGrowthPage />} />
              <Route path="acquisition" element={<AnalyticsAcquisitionPage />} />
              <Route path="retention" element={<AnalyticsRetentionPage />} />
              <Route path="downloads" element={<AnalyticsDownloadsPage />} />
            </Route>
            <Route path="analytics/product" element={<AnalyticsSectionShell sectionId="product" />}>
              <Route index element={<AnalyticsRedirect to="/admin/analytics/product/clips" />} />
              <Route path="clips" element={<AnalyticsClipsPage />} />
              <Route path="games" element={<AnalyticsGamesPage />} />
              <Route path="features" element={<AnalyticsFeaturesPage />} />
              <Route path="folders" element={<AnalyticsFoldersPage />} />
              <Route path="sharing" element={<AnalyticsSharingPage />} />
            </Route>
            <Route path="analytics/business" element={<AnalyticsSectionShell sectionId="business" />}>
              <Route index element={<AnalyticsRedirect to="/admin/analytics/business/revenue" />} />
              <Route path="revenue" element={<AnalyticsRevenuePage />} />
              <Route path="infrastructure" element={<AnalyticsInfrastructurePage />} />
            </Route>
            <Route path="analytics/health" element={<AnalyticsSectionShell sectionId="health" />}>
              <Route index element={<AnalyticsHealthPage />} />
              <Route path="errors" element={<AdminErrorsPage />} />
            </Route>
            {analyticsLegacyRedirects.map((item) => (
              <Route key={item.from} path={item.from} element={<AnalyticsRedirect to={item.to} />} />
            ))}
            <Route path="audit" element={<AdminAuditPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        {admin || messages ? null : <SiteFooter />}
      </div>
  );
}
