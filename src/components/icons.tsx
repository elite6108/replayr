import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconHome(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" />
    </Icon>
  );
}

export function IconLibrary(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="7" height="6" rx="1" />
      <rect x="14" y="5" width="7" height="6" rx="1" />
      <rect x="3" y="14" width="7" height="6" rx="1" />
      <rect x="14" y="14" width="7" height="6" rx="1" />
    </Icon>
  );
}

export function IconRecord(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconClips(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="6" width="17" height="12" rx="2" />
      <path d="m10 10 5 2.5L10 15z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconExplore(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="m10.2 10.2 6-1.6-1.6 6-4.4-4.4z" />
    </Icon>
  );
}

export function IconFriends(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M4 19a5 5 0 0 1 10 0" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M16 19a4 4 0 0 1 4-3.5" />
    </Icon>
  );
}

export function IconMessages(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 17.5H9l-4 3v-3H5A1.5 1.5 0 0 1 3.5 16V8A1.5 1.5 0 0 1 5 6.5z" />
      <path d="M8 11h.01M12 11h.01M16 11h.01" />
    </Icon>
  );
}

export function IconUploads(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 16V7" />
      <path d="m8.5 10 3.5-3.5L15.5 10" />
      <path d="M5 18h14" />
    </Icon>
  );
}

export function IconAdmin(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 19 7v5.2c0 4.2-2.8 7.2-7 8.3-4.2-1.1-7-4.1-7-8.3V7z" />
      <path d="m9.2 12.2 1.9 1.9 3.7-3.8" />
    </Icon>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3V20.5M4.8 6.5l1.6 1.6M17.6 15.9l1.6 1.6M3.5 12h2.2M18.3 12H20.5M4.8 17.5l1.6-1.6M17.6 8.1l1.6-1.6" />
    </Icon>
  );
}

export function IconProfile(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </Icon>
  );
}

export function IconGames(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 15.5c-2 0-3.5-1.4-3.5-3.2C3 10 5 8.5 7.2 8.8c.6-2 2.4-3.3 4.8-3.3s4.2 1.3 4.8 3.3c2.2-.3 4.2 1.2 4.2 3.5 0 1.8-1.5 3.2-3.5 3.2H6.5z" />
      <path d="M8 12v3M6.5 13.5h3M16 12.2h.01M17.6 13.8h.01" />
    </Icon>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 7.5h6l1.5 2h9.5v9.5h-17z" />
      <path d="M3.5 7.5V5.8A1.3 1.3 0 0 1 4.8 4.5h4.1L10.5 6" />
    </Icon>
  );
}

export function IconCloud(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.5 17.5h9.2A3.8 3.8 0 0 0 18 10.2 5.2 5.2 0 0 0 8.2 9.4 3.7 3.7 0 0 0 7.5 17.5z" />
    </Icon>
  );
}

export function IconGoogle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 11.2v2.4h5.4A5.6 5.6 0 1 1 12 6.4a5.4 5.4 0 0 1 3.8 1.5l1.7-1.7A8 8 0 1 0 12 20a7.7 7.7 0 0 0 7.6-6 8 8 0 0 0 .2-1.8z" />
    </Icon>
  );
}

export function IconDiscord(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.2 8.8c1.6-.8 3.1-1.1 3.8-1.2l.4 1c1 .1 2 .4 3 .9 1.4 2 1.9 4.1 1.7 6.1-1.1.5-2.2.9-3.4 1.1l-.6-1.1c.4-.1.8-.3 1.1-.5-.3-.2-.6-.4-.9-.6-.9.4-1.9.6-2.9.6s-2-.2-2.9-.6c-.3.2-.6.4-.9.6.3.2.7.4 1.1.5l-.6 1.1c-1.2-.2-2.3-.6-3.4-1.1-.3-2.1.2-4.3 1.7-6.2.9-.4 1.8-.7 2.8-.8l.4-1c.7.1 2.2.4 3.8 1.2z" />
      <circle cx="9.4" cy="12.6" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.6" cy="12.6" r="1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconX(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 5.5 10.8 12 5.2 18.5h2.2L12 13.4l4.4 5.1h2.4L12.8 11.8 18.8 5.5h-2.2L12 10.4 7.4 5.5z" />
    </Icon>
  );
}

export function IconApple(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16.2 8.6c-.9 0-2 .6-2.6.6-.7 0-1.7-.6-2.8-.6-2.3.1-4.4 2-4.4 5.1 0 2 .7 4.1 1.7 5.5.8 1.1 1.6 2.2 2.8 2.2 1.1 0 1.5-.7 2.8-.7s1.6.7 2.8.7c1.2 0 1.9-1.1 2.7-2.2.8-1.2 1.1-2.4 1.1-2.5 0 0-2.2-.8-2.2-3.3 0-2.1 1.7-3 1.8-3.1-1-.1-2.2.6-2.7.6z" />
      <path d="M14.8 6.6c.6-.7 1-1.7.9-2.6-1 .1-2.1.7-2.7 1.5-.6.7-1 1.6-.9 2.5 1.1 0 2.1-.6 2.7-1.4z" />
    </Icon>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 7 9 5-9 5z" />
    </Icon>
  );
}

export function IconStar(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 4 2.2 4.6L19 9.2l-3.5 3.3.9 4.9L12 15.2 7.6 17.4l.9-4.9L5 9.2l4.8-.6z" />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.2-4.2" />
    </Icon>
  );
}

export function IconBell(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </Icon>
  );
}

export function IconTikTok({ size = 16, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className} {...props}>
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.77.14 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1v-3.5a6.34 6.34 0 0 0-6.34 6.34A6.34 6.34 0 0 0 9.5 20.65a6.34 6.34 0 0 0 6.34-6.34V8.73a8.18 8.18 0 0 0 4.77 1.52V6.79a4.84 4.84 0 0 1-1.02-.1z" />
    </svg>
  );
}

export function IconInstagram({ size = 16, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className} {...props}>
      <path d="M12 2.16c3.2 0 3.58.01 4.85.07 3.25.15 4.77 1.69 4.92 4.92.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.15 3.23-1.66 4.77-4.92 4.92-1.27.06-1.64.07-4.85.07s-3.58-.01-4.85-.07c-3.26-.15-4.77-1.7-4.92-4.92-.06-1.27-.07-1.64-.07-4.85s.01-3.58.07-4.85C2.38 3.92 3.9 2.38 7.15 2.23 8.42 2.17 8.8 2.16 12 2.16M12 0C8.74 0 8.33.01 7.05.07 2.7.27.27 2.69.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.2 4.36 2.62 6.78 6.98 6.98C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c4.35-.2 6.78-2.62 6.98-6.98.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95C23.73 2.7 21.31.27 16.95.07 15.67.01 15.26 0 12 0zm0 5.84A6.16 6.16 0 1 0 18.16 12 6.16 6.16 0 0 0 12 5.84zM12 16a4 4 0 1 1 4-4 4 4 0 0 1-4 4zm6.41-11.85a1.44 1.44 0 1 0 1.44 1.44 1.44 1.44 0 0 0-1.44-1.44z" />
    </svg>
  );
}

export function IconYoutube({ size = 16, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className} {...props}>
      <path d="M23.5 6.2a3.02 3.02 0 0 0-2.12-2.14C19.54 3.67 12 3.67 12 3.67s-7.54 0-9.38.39A3.02 3.02 0 0 0 .5 6.2 31.6 31.6 0 0 0 0 12a31.6 31.6 0 0 0 .5 5.8 3.02 3.02 0 0 0 2.12 2.14c1.84.39 9.38.39 9.38.39s7.54 0 9.38-.39a3.02 3.02 0 0 0 2.12-2.14A31.6 31.6 0 0 0 24 12a31.6 31.6 0 0 0-.5-5.8zM9.75 15.57V8.43L15.84 12z" />
    </svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.4" />
    </Icon>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a2.4 2.4 0 0 0 3.4 3.4" />
      <path d="M7.1 7.2C4.8 8.5 3.1 10.6 2 12c0 0 3.6 6 10 6 1.7 0 3.2-.3 4.5-.9" />
      <path d="M10.3 6.1C10.9 6 11.4 6 12 6c6.4 0 10 6 10 6a18.4 18.4 0 0 1-2.2 2.8" />
    </Icon>
  );
}

export function IconLock(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

export function IconUnlock(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </Icon>
  );
}

export function IconMore(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function IconGrip(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 6v12M15 6v12" />
    </Icon>
  );
}

export function IconGear(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.8 6.4l1.6 1.6M17.6 16l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.8 17.6l1.6-1.6M17.6 8l1.6-1.6" />
    </Icon>
  );
}

export function IconSpeaker(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 8.5 6.5 11H4v2h2.5L10 15.5z" />
      <path d="M14.2 8.8a4.2 4.2 0 0 1 0 6.4" />
      <path d="M16.6 6.6a7.4 7.4 0 0 1 0 10.8" />
    </Icon>
  );
}

export function IconSpeakerOff(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 8.5 6.5 11H4v2h2.5L10 15.5z" />
      <path d="M15 9.5 20 14.5M20 9.5 15 14.5" />
    </Icon>
  );
}

export function IconFit(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="6" width="16" height="12" rx="1.5" />
      <path d="M8 10h8v4H8z" />
    </Icon>
  );
}

export function IconCenter(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <circle cx="12" cy="12" r="2" />
    </Icon>
  );
}

export function IconReset(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 5.5V9h3.5" />
    </Icon>
  );
}

export function IconSafeArea(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="6" width="16" height="12" rx="1" />
      <rect x="7" y="8.5" width="10" height="7" rx="0.5" strokeDasharray="2 2" />
    </Icon>
  );
}

export function IconChevron(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12.5l4.2 4.2L19 7.5" />
    </Icon>
  );
}
