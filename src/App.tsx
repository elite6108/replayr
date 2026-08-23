import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { RecordPage } from "./pages/RecordPage";
import { ExplorePage } from "./pages/ExplorePage";
import { FriendsPage } from "./pages/FriendsPage";
import { GamesPage } from "./pages/GamesPage";
import { GamePage } from "./pages/GamePage";
import { SettingsPage } from "./pages/SettingsPage";
import { ProfilePage } from "./pages/ProfilePage";
import { AdminPage } from "./pages/AdminPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { MicDisconnectToasts } from "./components/layout/MicDisconnectToasts";
import { ToastRegion } from "./components/common/ToastRegion";
import { useAuthStore } from "./stores/authStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useDetectionStore } from "./stores/detectionStore";
import { useRecordingStore } from "./stores/recordingStore";
import { useLibraryStore } from "./stores/libraryStore";
import { useCloudStore } from "./stores/cloudStore";
import { useUpdateStore } from "./stores/updateStore";
import { APP_NAME } from "./branding";

export default function App() {
  const loaded = useSettingsStore((state) => state.loaded);
  const onboardingCompleted = useSettingsStore((state) => state.settings.onboardingCompleted);
  const loadSettings = useSettingsStore((state) => state.load);
  const authReady = useAuthStore((state) => state.ready);
  const initializeAuth = useAuthStore((state) => state.initialize);
  const initializeDetection = useDetectionStore((state) => state.initialize);
  const initializeRecording = useRecordingStore((state) => state.initialize);
  const initializeLibrary = useLibraryStore((state) => state.initialize);
  const initializeCloud = useCloudStore((state) => state.initialize);
  const initializeUpdates = useUpdateStore((state) => state.initialize);
  const userId = useAuthStore((state) => state.user?.id);
  const refreshCloud = useCloudStore((state) => state.refresh);

  useEffect(() => {
    void loadSettings();
    void initializeAuth();
    void initializeDetection();
    void initializeRecording();
    void initializeLibrary();
    void initializeCloud();
    void initializeUpdates();
    const splash = window.setTimeout(() => {
      if (!useSettingsStore.getState().loaded) {
        useSettingsStore.setState({ loaded: true });
      }
      if (!useAuthStore.getState().ready) {
        useAuthStore.setState({ ready: true });
      }
    }, 2500);
    return () => window.clearTimeout(splash);
  }, [loadSettings, initializeAuth, initializeDetection, initializeRecording, initializeLibrary, initializeCloud, initializeUpdates]);

  useEffect(() => {
    void refreshCloud();
  }, [userId, refreshCloud]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") void refreshCloud();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshCloud]);

  if (!loaded || !authReady) {
    return <div className="onboarding-shell muted">Starting {APP_NAME}…</div>;
  }

  if (!onboardingCompleted) {
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
          <Route path="/uploads" element={<Navigate to="/library/cloud" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
