import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { NavRail } from "./NavRail";
import { TopBar } from "./TopBar";
import { DesktopShortcutPrompt } from "./DesktopShortcutPrompt";
import { AnnouncementHost } from "./AnnouncementHost";
import { ClipPlayer } from "../common/ClipPlayer";
import { CloudClipPlayer } from "../common/CloudClipPlayer";
import { ToastRegion } from "../common/ToastRegion";
import { MicDisconnectToasts } from "./MicDisconnectToasts";
import { CameraDisconnectToasts } from "./CameraDisconnectToasts";

function TrayNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("navigate", (event) => {
      navigate(event.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [navigate]);
  return null;
}

export function AppShell() {
  return (
    <div className="app-shell">
      <TrayNavigation />
      <NavRail />
      <div className="workspace">
        <TopBar />
        <AnnouncementHost />
        <main className="page">
          <Outlet />
        </main>
      </div>
      <ToastRegion />
        <MicDisconnectToasts />
        <CameraDisconnectToasts />
      <DesktopShortcutPrompt />
      <ClipPlayer />
      <CloudClipPlayer />
    </div>
  );
}
