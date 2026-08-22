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

export function IconUploads(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 16V7" />
      <path d="m8.5 10 3.5-3.5L15.5 10" />
      <path d="M5 18h14" />
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

export function IconLogo(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="5" width="16" height="14" rx="2.5" />
      <path d="M8 12h2M14 9v6" />
    </Icon>
  );
}
