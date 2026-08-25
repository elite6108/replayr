import { NavLink } from "react-router-dom";
import type { ComponentType, SVGProps } from "react";
import { APP_NAME } from "../../branding";
import { useAuthStore } from "../../stores/authStore";
import { useBillingStore } from "../../stores/billingStore";
import { useDetectionStore } from "../../stores/detectionStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useRecordingStore } from "../../stores/recordingStore";
import logoMark from "../../assets/replayr-mark.png";
import { IconAdmin, IconExplore, IconFriends, IconGames, IconHome, IconLibrary, IconMessages, IconProfile, IconRecord, IconSettings } from "../icons";
import { isAdminUser } from "../../utils/admin";
import { formatBytes } from "../../utils/format";
import { useSocialUnreadStore } from "../../stores/socialUnreadStore";
import { useUpdateStore } from "../../stores/updateStore";

type Glyph = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const items: { to: string; label: string; icon: Glyph; end?: boolean; live?: boolean }[] = [
  { to: "/", label: "Home", icon: IconHome, end: true },
  { to: "/library", label: "Library", icon: IconLibrary },
  { to: "/explore", label: "Explore", icon: IconExplore },
  { to: "/games", label: "Games", icon: IconGames },
  { to: "/record", label: "Record", icon: IconRecord, live: true },
  { to: "/friends", label: "Friends", icon: IconFriends },
  { to: "/messages", label: "Messages", icon: IconMessages },
];

export function NavRail() {
  const detected = Boolean(useDetectionStore((state) => state.snapshot.name));
  const recording = useRecordingStore((state) => state.status.active);
  const clips = useLibraryStore((state) => state.clips);
  const storage = useAuthStore((state) => state.storage);
  const admin = isAdminUser(useAuthStore((state) => state.user), useAuthStore((state) => state.session?.access_token));
  const used = storage?.storage_used_bytes ?? 0;
  const limit = storage?.storage_limit_bytes ?? 0;
  const premium = useBillingStore((state) => state.status?.premium);
  const updateReady = useUpdateStore((state) => state.status === "ready");
  const friendsUnread = useSocialUnreadStore((state) => state.friendsUnread);
  const messagesUnread = useSocialUnreadStore((state) => state.messagesUnread);

  return (
    <nav className="nav-rail" aria-label="Primary">
      <div className="nav-brand" title={APP_NAME}>
        <img src={logoMark} alt={APP_NAME} width={36} height={36} />
      </div>
      {items.map((item) => {
        const Glyph = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <span className="nav-icon">
              <Glyph size={18} />
              {item.live && (detected || recording) ? <span className="nav-live" /> : null}
              {item.to === "/friends" && friendsUnread ? <span className="nav-unread" title="Unread" /> : null}
              {item.to === "/messages" && messagesUnread ? <span className="nav-unread" title="Unread" /> : null}
            </span>
            <span>{item.label}</span>
          </NavLink>
        );
      })}
      <div className="nav-spacer" />
      {admin ? (
        <NavLink to="/admin" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
          <span className="nav-icon">
            <IconAdmin size={18} />
          </span>
          <span>Admin</span>
        </NavLink>
      ) : null}
      <NavLink to="/settings" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
        <span className="nav-icon">
          <IconSettings size={18} />
          {updateReady ? <span className="nav-update" title="Update ready" /> : null}
        </span>
        <span>Settings</span>
      </NavLink>
      <NavLink to="/profile" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
        <span className="nav-icon">
          <IconProfile size={18} />
        </span>
        <span>Account</span>
      </NavLink>
      <NavLink to="/profile" className="nav-storage">
        <strong>{storage ? formatBytes(used) : `${clips.length} clips`}</strong>
        {storage
          ? `${formatBytes(limit)} cloud${limit > 0 && used / limit >= 0.8 && !premium ? " · Upgrade" : ""}`
          : "On this PC"}
      </NavLink>
    </nav>
  );
}
