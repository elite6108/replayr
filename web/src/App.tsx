import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import { RequireAuth } from "./components/RequireAuth";
import { AuthProvider, useAuth } from "./lib/auth";
import { noteWebPresencePath } from "./lib/presence";
import { StaffPermissionsProvider } from "./lib/staff";
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
import { LibraryScreenshotsPage } from "./pages/LibraryScreenshotsPage";
import { MessagesPage } from "./pages/MessagesPage";
import { PricingPage } from "./pages/PricingPage";
import { ReleaseNotesPage } from "./pages/ReleaseNotesPage";
import { PublicFolderPage } from "./pages/PublicFolderPage";
import { ScreenshotPage } from "./pages/ScreenshotPage";
import { UserProfilePage } from "./pages/UserProfilePage";
import { AuthCallbackPage } from "./pages/AuthCallbackPage";
import { AuthDesktopPage } from "./pages/AuthDesktopPage";
import { AuthMobilePage } from "./pages/AuthMobilePage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { SignInPage } from "./pages/SignInPage";
import { AnnouncementHost } from "./components/AnnouncementHost";
import {
  getWebAnalyticsConsent,
  trackWebAppOpened,
  trackWebEvent,
} from "./lib/analytics";

const AdminApp = lazy(() => import("./pages/admin/AdminApp").then((mod) => ({ default: mod.AdminApp })));
const StaffApp = lazy(() => import("./pages/staff/StaffApp").then((mod) => ({ default: mod.StaffApp })));

function RouteFallback() {
  return <p className="muted">Loading…</p>;
}

export function App() {
  return (
    <AuthProvider>
      <StaffPermissionsProvider>
        <SocialUnreadProvider>
          <AppShell />
        </SocialUnreadProvider>
      </StaffPermissionsProvider>
    </AuthProvider>
  );
}

function AppShell() {
  const location = useLocation();
  const { session } = useAuth();
  const token = session?.access_token;
  const admin = location.pathname.startsWith("/admin") || location.pathname.startsWith("/staff");
  const messages = location.pathname.startsWith("/messages");
  useEffect(() => {
    noteWebPresencePath();
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void getWebAnalyticsConsent(token)
      .then((consent) => {
        if (cancelled || consent !== "allowed") return;
        trackWebAppOpened(token);
        trackWebEvent("screen.viewed", { screen: webScreen(location.pathname) }, token);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [location.pathname, token]);
  const oauthCode =
    new URLSearchParams(location.search).get("code") ||
    new URLSearchParams(location.hash.replace(/^#/, "")).get("code");
  const recoveryType =
    new URLSearchParams(location.search).get("type") === "recovery" ||
    new URLSearchParams(location.hash.replace(/^#/, "")).get("type") === "recovery";
  if (oauthCode && location.pathname === "/") {
    const dest = recoveryType ? "/auth/reset" : "/auth/desktop";
    return <Navigate to={`${dest}${location.search}${location.hash}`} replace />;
  }
  return (
      <div className={`site${admin ? " site-admin" : ""}${messages ? " site-messages" : ""}`}>
        <SiteHeader />
        <AnnouncementHost />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/waitlist" element={<WaitlistToComingSoon />} />
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/creators" element={<CreatorsPage />} />
          <Route path="/releases" element={<ReleaseNotesPage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/games/:slug" element={<GamePage />} />
          <Route path="/signin" element={<SignInPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/auth/reset" element={<ResetPasswordPage />} />
          <Route path="/auth/desktop" element={<AuthDesktopPage />} />
          <Route path="/auth/mobile" element={<AuthMobilePage />} />
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
            path="/library/screenshots"
            element={
              <RequireAuth>
                <LibraryScreenshotsPage />
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
          <Route path="/clip/:slug" element={<ClipPage />} />
          <Route path="/s/:slug" element={<ScreenshotPage />} />
          <Route path="/f/:token" element={<PublicFolderPage />} />
          <Route
            path="/admin/*"
            element={
              <Suspense fallback={<RouteFallback />}>
                <AdminApp />
              </Suspense>
            }
          />
          <Route
            path="/staff/*"
            element={
              <Suspense fallback={<RouteFallback />}>
                <StaffApp />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        {admin || messages ? null : <SiteFooter />}
      </div>
  );
}

function webScreen(pathname: string): string {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/library/screenshots")) return "screenshots";
  if (pathname.startsWith("/library/folders") || pathname.startsWith("/folders/")) return "folders";
  if (pathname.startsWith("/library")) return "library";
  if (pathname.startsWith("/messages")) return "messages";
  if (pathname.startsWith("/c/")) return "clip";
  if (pathname.startsWith("/s/")) return "screenshot";
  if (pathname.startsWith("/u/")) return "profile";
  if (pathname.startsWith("/games")) return "games";
  if (pathname.startsWith("/pricing")) return "pricing";
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname.startsWith("/staff")) return "staff";
  if (pathname.startsWith("/account")) return "account";
  if (pathname.startsWith("/signin") || pathname.startsWith("/auth/")) return "auth";
  return "other";
}

function WaitlistToComingSoon() {
  useEffect(() => {
    window.location.replace(`/coming-soon${window.location.search}`);
  }, []);
  return null;
}
