import { APP_NAME } from "../../branding";
import { WindowControls, WindowDragRegion } from "./WindowChrome";

/** Frameless window chrome: centered app name, wide drag strip, min/max/close. */
export function AppWindowTitleBar({ className }: { className?: string }) {
  return (
    <header className={["app-window-titlebar", className].filter(Boolean).join(" ")}>
      <WindowDragRegion className="app-window-titlebar-drag" aria-label="Drag window" />
      <span className="app-window-titlebar-title">{APP_NAME}</span>
      <WindowControls />
    </header>
  );
}
