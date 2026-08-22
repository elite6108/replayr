import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { NavRail } from "./NavRail";
import { TopBar } from "./TopBar";
import { ClipPlayer } from "../common/ClipPlayer";
import { ToastRegion } from "../common/ToastRegion";

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
        <main className="page">
          <Outlet />
        </main>
      </div>
      <ToastRegion />
      <ClipPlayer />
    </div>
  );
}
