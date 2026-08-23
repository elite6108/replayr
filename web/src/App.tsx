import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import { RequireAuth } from "./components/RequireAuth";
import { RequireAdmin } from "./components/RequireAdmin";
import { AuthProvider } from "./lib/auth";
import { AccountPage } from "./pages/AccountPage";
import { ClipPage } from "./pages/ClipPage";
import { CreatorsPage } from "./pages/CreatorsPage";
import { FeaturesPage } from "./pages/FeaturesPage";
import { FriendsPage } from "./pages/FriendsPage";
import { GamePage } from "./pages/GamePage";
import { GamesPage } from "./pages/GamesPage";
import { HomePage } from "./pages/HomePage";
import { LegalPage } from "./pages/LegalPage";
import { LibraryPage } from "./pages/LibraryPage";
import { PricingPage } from "./pages/PricingPage";
import { AuthCallbackPage } from "./pages/AuthCallbackPage";
import { AuthDesktopPage } from "./pages/AuthDesktopPage";
import { SignInPage } from "./pages/SignInPage";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminOverviewPage } from "./pages/admin/AdminOverviewPage";
import { AdminUsersPage } from "./pages/admin/AdminUsersPage";
import { AdminClipsPage } from "./pages/admin/AdminClipsPage";
import { AdminStoragePage } from "./pages/admin/AdminStoragePage";
import { AdminCreatorsPage } from "./pages/admin/AdminCreatorsPage";

export function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

function AppShell() {
  const location = useLocation();
  const admin = location.pathname.startsWith("/admin");
  return (
      <div className={`site${admin ? " site-admin" : ""}`}>
        <SiteHeader />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/creators" element={<CreatorsPage />} />
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
            path="/friends"
            element={
              <RequireAuth>
                <FriendsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/account"
            element={
              <RequireAuth>
                <AccountPage />
              </RequireAuth>
            }
          />
          <Route path="/c/:slug" element={<ClipPage />} />
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
            <Route path="clips" element={<AdminClipsPage />} />
            <Route path="storage" element={<AdminStoragePage />} />
            <Route path="creators" element={<AdminCreatorsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        {admin ? null : <SiteFooter />}
      </div>
  );
}
