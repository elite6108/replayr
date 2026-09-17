import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function IconOverview(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </Icon>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="2.4" />
      <circle cx="16" cy="9" r="2" />
      <path d="M4.5 18c.6-2.6 2.6-4 4.6-4s4 1.4 4.6 4" />
      <path d="M13.2 14.2c1.4-.4 3.2.2 4.3 2.8" />
    </Icon>
  );
}

export function IconBilling(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="6.5" width="17" height="11" rx="1.8" />
      <path d="M3.5 10h17" />
      <path d="M7 15h4" />
    </Icon>
  );
}

export function IconClips(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <path d="m10 10 5 2-5 2z" />
    </Icon>
  );
}

export function IconCloud(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.5 17h9.2a3.3 3.3 0 0 0 .5-6.5 5 5 0 0 0-9.6-1.2A3.5 3.5 0 0 0 7.5 17Z" />
    </Icon>
  );
}

export function IconCreators(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 4 2.3 4.8 5.2.7-3.8 3.6.9 5.2L12 16.3 7.4 18.3l.9-5.2L4.5 9.5l5.2-.7Z" />
    </Icon>
  );
}

export function IconAnnouncements(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 11v2a2 2 0 0 0 2 2h1l3 3V8L8 11H7a2 2 0 0 0-2 2Z" />
      <path d="M16 8.5a4.5 4.5 0 0 1 0 7" />
    </Icon>
  );
}

export function IconErrors(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5 20.5 19h-17Z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.5" r="0.7" fill="currentColor" stroke="none" />
    </Icon>
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

export function IconShield(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 19 6.5v5.2c0 4.2-2.8 7.2-7 8.8-4.2-1.6-7-4.6-7-8.8V6.5Z" />
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

export function IconChart(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 19h15" />
      <path d="M7 16v-4M12 16V8M17 16v-7" />
    </Icon>
  );
}

export function IconGrowth(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 16.5 10 11l3.5 3.5 6-7" />
      <path d="M14.5 7.5h5v5" />
    </Icon>
  );
}

export function IconProduct(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 20 8v8l-8 4.5L4 16V8Z" />
      <path d="M12 12.5 20 8M12 12.5 4 8M12 12.5V20.5" />
    </Icon>
  );
}

export function IconBusiness(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="8" width="16" height="11" rx="1.5" />
      <path d="M9 8V6.5A1.5 1.5 0 0 1 10.5 5h3A1.5 1.5 0 0 1 15 6.5V8" />
    </Icon>
  );
}

export function IconHealth(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 12h3l1.5-3 2.5 6 1.5-3h6.5" />
      <path d="M4 17.5h16" />
    </Icon>
  );
}

export function IconReports(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 4.5h7.5L19.5 9v10.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z" />
      <path d="M14.5 4.5V9h4.5M8.5 13h7M8.5 16.5h5" />
    </Icon>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.4 6.4l1.4 1.4M16.2 16.2l1.4 1.4M17.6 6.4l-1.4 1.4M7.8 16.2l-1.4 1.4" />
    </Icon>
  );
}

export function IconAccounts(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="3" />
      <path d="M5.5 19c.8-3.2 3.2-5 6.5-5s5.7 1.8 6.5 5" />
    </Icon>
  );
}

export function IconActive(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 8v4l2.5 1.5" />
    </Icon>
  );
}

export function IconWaitlist(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 8l8 5 8-5" />
    </Icon>
  );
}

export function IconPremium(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 16.5 7.5 8l4.5 4 4.5-4 2.5 8.5Z" />
    </Icon>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 7h14M5 12h14M5 17h14" />
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
