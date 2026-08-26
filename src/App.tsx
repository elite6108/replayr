import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { RecordPage } from "./pages/RecordPage";
import { ExplorePage } from "./pages/ExplorePage";
import { FriendsPage } from "./pages/FriendsPage";
import { MessagesPage } from "./pages/MessagesPage";
import { GamesPage } from "./pages/GamesPage";
import { GamePage } from "./pages/GamePage";
import { SettingsPage } from "./pages/SettingsPage";
import { ProfilePage } from "./pages/ProfilePage";
import { UserProfilePage } from "./pages/UserProfilePage";
import { AdminPage } from "./pages/AdminPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { EditorPage } from "./pages/EditorPage";
import { MicDisconnectToasts } from "./components/layout/MicDisconnectToasts";
import { ToastRegion } from "./components/common/ToastRegion";
import { useAuthStore } from "./stores/authStore";
import { useBillingStore } from "./stores/billingStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useDetectionStore } from "./stores/detectionStore";
import { useRecordingStore } from "./stores/recordingStore";
import { useLibraryStore } from "./stores/libraryStore";
import { useCloudStore } from "./stores/cloudStore";
import { useUpdateStore } from "./stores/updateStore";
import { useSocialUnreadSync } from "./hooks/useSocialUnreadSync";

export default function App() {
  const loaded = useSettingsStore((state) => state.loaded);
  const onboardingCompleted = useSettingsStore((state) => state.settings.onboardingCompleted);
  const loadSettings = useSettingsStore((state) => state.load);
  const initializeAuth = useAuthStore((state) => state.initialize);
  const initializeDetection = useDetectionStore((state) => state.initialize);
  const initializeRecording = useRecordingStore((state) => state.initialize);
  const initializeLibrary = useLibraryStore((state) => state.initialize);
  const initializeCloud = useCloudStore((state) => state.initialize);
  const initializeUpdates = useUpdateStore((state) => state.initialize);
  const userId = useAuthStore((state) => state.user?.id);
  const accessToken = useAuthStore((state) => state.session?.access_token ?? null);
  const loadBilling = useBillingStore((state) => state.load);
  const refreshCloud = useCloudStore((state) => state.refresh);
  useSocialUnreadSync();

  useEffect(() => {
    void loadSettings();
    void initializeAuth();
    void initializeDetection();
    void initializeRecording();
    void initializeLibrary();
    void initializeCloud();
    void initializeUpdates();
  }, [loadSettings, initializeAuth, initializeDetection, initializeRecording, initializeLibrary, initializeCloud, initializeUpdates]);

  useEffect(() => {
    void refreshCloud();
    void loadBilling(accessToken);
  }, [userId, accessToken, refreshCloud, loadBilling]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        void refreshCloud();
        void loadBilling(useAuthStore.getState().session?.access_token ?? null);
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshCloud]);

  // Open the app immediately. Settings/auth continue in the background.
  // Onboarding only appears once we know it is actually unfinished.
  if (loaded && !onboardingCompleted) {
    return (
      <>
        <MicDisconnectToasts />
        <OnboardingPage />
        <ToastRegion />
      </>
    );
  }

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/library" element={<LibraryPage view="local" />} />
          <Route path="/library/cloud" element={<LibraryPage view="cloud" />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/games/:slug" element={<GamePage />} />
          <Route path="/record" element={<RecordPage />} />
          <Route path="/clips" element={<Navigate to="/library/cloud" replace />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/friends" element={<FriendsPage />} />
          <Route path="/u/:username" element={<UserProfilePage />} />
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="/messages/:conversationId" element={<MessagesPage />} />
          <Route path="/uploads" element={<Navigate to="/library/cloud" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/editor/:clipId" element={<EditorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
