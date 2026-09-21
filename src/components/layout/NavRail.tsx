import { NavLink, useNavigate } from "react-router-dom";
import type { ComponentType, MouseEvent } from "react";
import { useAuthStore } from "../../stores/authStore";
import { useBillingStore } from "../../stores/billingStore";
import { useDetectionStore } from "../../stores/detectionStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useRecordingStore } from "../../stores/recordingStore";
import { APP_NAME } from "../../branding";
import logoMark from "../../assets/replayr-mark.png";
import {
  IconAdmin,
  IconExplore,
  IconFriends,
  IconGames,
  IconHome,
  IconLibrary,
  IconMessages,
  IconRecord,
  IconSettings,
  type IconProps,
} from "../icons";
import { isAdminUser } from "../../utils/admin";
import { formatBytes, initials } from "../../utils/format";
import { useSocialUnreadStore } from "../../stores/socialUnreadStore";
import { useUpdateStore } from "../../stores/updateStore";

type Glyph = ComponentType<IconProps>;

const items: { to: string; label: string; icon: Glyph; end?: boolean; live?: boolean; divideAfter?: boolean }[] = [
  { to: "/", label: "Home", icon: IconHome, end: true },
  { to: "/library", label: "Library", icon: IconLibrary },
  { to: "/record", label: "Capture", icon: IconRecord, live: true },
  { to: "/explore", label: "Explore", icon: IconExplore },
  { to: "/games", label: "Games", icon: IconGames, divideAfter: true },
  { to: "/friends", label: "Following", icon: IconFriends },
  { to: "/messages", label: "Messages", icon: IconMessages },
];

export function NavRail() {
  const navigate = useNavigate();
  const detected = Boolean(useDetectionStore((state) => state.snapshot.name));
  const recording = useRecordingStore((state) => state.status.active);
  const clips = useLibraryStore((state) => state.clips);
  const storage = useAuthStore((state) => state.storage);
  const user = useAuthStore((state) => state.user);
  const profile = useAuthStore((state) => state.profile);
  const admin = isAdminUser(user, useAuthStore((state) => state.session?.access_token));
  const used = storage?.storage_used_bytes ?? 0;
  const limit = storage?.storage_limit_bytes ?? 0;
  const premium = useBillingStore((state) => state.status?.premium);
  const updateReady = useUpdateStore((state) => state.status === "ready");
  const friendsUnread = useSocialUnreadStore((state) => state.friendsUnread);
  const messagesUnread = useSocialUnreadStore((state) => state.messagesUnread);
  const accountName = profile?.display_name || profile?.username || (user ? "Online" : "Guest");
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  function go(event: MouseEvent, to: string) {
    event.preventDefault();
    navigate(to, { flushSync: true });
  }

  return (
    <nav className="nav-rail" aria-label="Primary">
      <NavLink to="/" end className="nav-logo" title="Home" onClick={(event) => go(event, "/")}>
        <img src={logoMark} alt={APP_NAME} />
      </NavLink>
      {items.map((item) => {
        const Glyph = item.icon;
        return (
          <div key={item.to} className="nav-slot">
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [
                  "nav-item",
                  isActive ? "active" : "",
                  item.to === "/record" ? "nav-item-record" : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              }
              title={item.label}
              onClick={(event) => go(event, item.to)}
            >
              {({ isActive }) => (
                <>
                  <span className="nav-icon">
                    <Glyph size={item.to === "/record" ? 24 : 22} weight={isActive ? "fill" : "regular"} />
                    {item.live && (detected || recording) ? <span className="nav-live" /> : null}
                    {item.to === "/friends" && friendsUnread ? <span className="nav-unread" title="Unread" /> : null}
                    {item.to === "/messages" && messagesUnread ? <span className="nav-unread" title="Unread" /> : null}
                  </span>
                  <span>{item.label}</span>
                </>
              )}
            </NavLink>
            {item.divideAfter ? <div className="nav-divider" /> : null}
          </div>
        );
      })}
      <div className="nav-spacer" />
      {admin ? (
        <NavLink to="/admin" className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")} title="Admin" onClick={(event) => go(event, "/admin")}>
          {({ isActive }) => (
            <>
              <span className="nav-icon">
                <IconAdmin size={18} weight={isActive ? "fill" : "regular"} />
              </span>
              <span>Admin</span>
            </>
          )}
        </NavLink>
      ) : null}
      <NavLink
        to="/settings"
        className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
        title="Settings"
        onClick={(event) => go(event, "/settings")}
      >
        {({ isActive }) => (
          <>
            <span className="nav-icon">
              <IconSettings size={18} weight={isActive ? "fill" : "regular"} />
              {updateReady ? <span className="nav-update" title="Update ready" /> : null}
            </span>
            <span>Settings</span>
          </>
        )}
      </NavLink>
      <NavLink
        to="/profile"
        className={({ isActive }) => (isActive ? "nav-account active" : "nav-account")}
        title="Account"
        onClick={(event) => go(event, "/profile")}
      >
        <span className="avatar">{initials(profile?.username || profile?.display_name || user?.email || "R")}</span>
        <span className="nav-account-copy">
          <strong>{accountName}</strong>
          <span className={premium ? "" : "offline"}>{premium ? "PRO" : APP_NAME}</span>
        </span>
        <span className="nav-storage">
          {storage ? (
            <>
              {formatBytes(used)} / {formatBytes(limit)}
              {limit > 0 && used / limit >= 0.8 && !premium ? " · Upgrade" : ""}
              <span className="meter" aria-hidden="true">
                <span style={{ width: `${pct}%` }} />
              </span>
            </>
          ) : (
            `${clips.length} clips`
          )}
        </span>
      </NavLink>
    </nav>
  );
}
