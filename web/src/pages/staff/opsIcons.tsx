import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function IconBoard(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="5" height="15" rx="1.2" />
      <rect x="9.5" y="4.5" width="5" height="10" rx="1.2" />
      <rect x="15.5" y="4.5" width="5" height="13" rx="1.2" />
    </Icon>
  );
}

export function IconTasks(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M4.5 6.5 5.5 7.5 7 5.5" />
      <path d="M4.5 12.5 5.5 13.5 7 11.5" />
      <circle cx="5.5" cy="18" r="1.2" />
    </Icon>
  );
}

export function IconStaff(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="2.4" />
      <circle cx="16" cy="9" r="2" />
      <path d="M4.5 18c.6-2.6 2.6-4 4.6-4s4 1.4 4.6 4" />
      <path d="M13.2 14.2c1.4-.4 3.2.2 4.3 2.8" />
    </Icon>
  );
}

export function IconShield(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 19 6.5v5.2c0 4.2-2.8 7.2-7 8.8-4.2-1.6-7-4.6-7-8.8V6.5Z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  );
}

export function IconAudit(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 4.5h8.5A1.5 1.5 0 0 1 18 6v13.5H8A1.5 1.5 0 0 1 6.5 18V6A1.5 1.5 0 0 1 8 4.5Z" />
      <path d="M9.5 9h5M9.5 12.5h5M9.5 16h3.5" />
    </Icon>
  );
}

export function IconHome(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4 11 8-7 8 7" />
      <path d="M6.5 10.5V19h11v-8.5" />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  );
}

export function IconFilter(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6h16L14 13v5l-4 2v-7Z" />
    </Icon>
  );
}

export function IconSort(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 6v12M8 6 5.5 8.5M8 6l2.5 2.5" />
      <path d="M16 18V6M16 18l2.5-2.5M16 18l-2.5-2.5" />
    </Icon>
  );
}

export function IconDots(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.15" fill="currentColor" stroke="none" />
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

export function IconStar(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 4 2.3 4.8 5.2.7-3.8 3.6.9 5.2L12 16.3 7.4 18.3l.9-5.2L4.5 9.5l5.2-.7Z" />
    </Icon>
  );
}

export function IconChevron(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m7 10 5 5 5-5" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m7 7 10 10M17 7 7 17" />
    </Icon>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Icon {...props} width="14" height="14">
      <path d="M5 7h14" />
      <path d="M9 7V5.5h6V7" />
      <path d="M8 7l.7 11h6.6L16 7" />
    </Icon>
  );
}

export function IconInbox(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 13 7 5.5h10L19.5 13v5.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1Z" />
      <path d="M4.5 13h4.2l1.3 2h4l1.3-2h4.2" />
    </Icon>
  );
}

export function IconProgress(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  );
}

export function IconReview(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11.5 5.5 19 12l-7.5 6.5v-4.2C6.5 14.3 5 16.5 4.5 19 4.8 13.8 7.4 10.8 11.5 9.7Z" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="7.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5.2" />
    </Icon>
  );
}

export function IconComment(props: IconProps) {
  return (
    <Icon {...props} width="14" height="14">
      <path d="M5 6.5h14v8.5a1 1 0 0 1-1 1H9l-4 3v-12.5Z" />
    </Icon>
  );
}

export function IconCalendar(props: IconProps) {
  return (
    <Icon {...props} width="14" height="14">
      <rect x="4" y="6" width="16" height="13" rx="1.5" />
      <path d="M8 4.5V7M16 4.5V7M4 10h16" />
    </Icon>
  );
}

export function IconGrip(props: IconProps) {
  return (
    <Icon {...props} width="12" height="16">
      <circle cx="9" cy="6" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.15" fill="currentColor" stroke="none" />
    </Icon>
  );
}
