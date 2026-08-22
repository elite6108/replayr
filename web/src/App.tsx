import { Navigate, Route, Routes } from "react-router-dom";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import { RequireAuth } from "./components/RequireAuth";
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
import { SignInPage } from "./pages/SignInPage";

export function App() {
  return (
    <AuthProvider>
      <div className="site">
        <SiteHeader />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/creators" element={<CreatorsPage />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/games/:slug" element={<GamePage />} />
          <Route path="/signin" element={<SignInPage />} />
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <SiteFooter />
      </div>
    </AuthProvider>
  );
}
