import type { ComponentType, ReactNode, SVGProps } from "react";
import {
  ArrowCounterClockwise,
  ArrowsOut,
  Bell,
  CaretDown,
  ChatCircle,
  Check,
  Cloud,
  Compass,
  Crosshair,
  DotsSixVertical,
  DotsThreeVertical,
  Eye,
  EyeSlash,
  FilmStrip,
  Folder,
  GameController,
  Gear,
  Headphones,
  House,
  Lock,
  LockOpen,
  MagnifyingGlass,
  Play,
  Plus,
  Record,
  Selection,
  ShieldCheck,
  SpeakerHigh,
  SpeakerSlash,
  SquaresFour,
  Star,
  UploadSimple,
  User,
  Users,
  type IconWeight,
} from "@phosphor-icons/react";

export type { IconWeight };

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number;
  weight?: IconWeight;
};

type PhosphorIcon = ComponentType<{
  size?: string | number;
  weight?: IconWeight;
  className?: string;
  color?: string;
  mirrored?: boolean;
  "aria-hidden"?: boolean | "true" | "false";
}>;

function phosphor(Icon: PhosphorIcon, props: IconProps) {
  const { size = 18, weight = "regular", className, color, ...rest } = props;
  return (
    <Icon
      size={size}
      weight={weight}
      className={className}
      color={color}
      aria-hidden="true"
      {...rest}
    />
  );
}

export function IconHome(props: IconProps) {
  return phosphor(House, props);
}

export function IconLibrary(props: IconProps) {
  return phosphor(SquaresFour, props);
}

export function IconRecord(props: IconProps) {
  return phosphor(Record, props);
}

export function IconClips(props: IconProps) {
  return phosphor(FilmStrip, props);
}

export function IconExplore(props: IconProps) {
  return phosphor(Compass, props);
}

export function IconFriends(props: IconProps) {
  return phosphor(Users, props);
}

export function IconMessages(props: IconProps) {
  return phosphor(ChatCircle, props);
}

export function IconUploads(props: IconProps) {
  return phosphor(UploadSimple, props);
}

export function IconAdmin(props: IconProps) {
  return phosphor(ShieldCheck, props);
}

export function IconSettings(props: IconProps) {
  return phosphor(Gear, props);
}

export function IconProfile(props: IconProps) {
  return phosphor(User, props);
}

export function IconGames(props: IconProps) {
  return phosphor(GameController, props);
}

export function IconFolder(props: IconProps) {
  return phosphor(Folder, props);
}

export function IconCloud(props: IconProps) {
  return phosphor(Cloud, props);
}

export function IconPlay(props: IconProps) {
  return phosphor(Play, props);
}

export function IconStar(props: IconProps) {
  return phosphor(Star, props);
}

export function IconSearch(props: IconProps) {
  return phosphor(MagnifyingGlass, props);
}

export function IconBell(props: IconProps) {
  return phosphor(Bell, props);
}

export function IconEye(props: IconProps) {
  return phosphor(Eye, props);
}

export function IconEyeOff(props: IconProps) {
  return phosphor(EyeSlash, props);
}

export function IconLock(props: IconProps) {
  return phosphor(Lock, props);
}

export function IconUnlock(props: IconProps) {
  return phosphor(LockOpen, props);
}

export function IconMore(props: IconProps) {
  return phosphor(DotsThreeVertical, props);
}

export function IconPlus(props: IconProps) {
  return phosphor(Plus, props);
}

export function IconGrip(props: IconProps) {
  return phosphor(DotsSixVertical, props);
}

export function IconGear(props: IconProps) {
  return phosphor(Gear, props);
}

export function IconSpeaker(props: IconProps) {
  return phosphor(SpeakerHigh, props);
}

export function IconSpeakerOff(props: IconProps) {
  return phosphor(SpeakerSlash, props);
}

export function IconHeadphones(props: IconProps) {
  return phosphor(Headphones, props);
}

export function IconFit(props: IconProps) {
  return phosphor(ArrowsOut, props);
}

export function IconCenter(props: IconProps) {
  return phosphor(Crosshair, props);
}

export function IconReset(props: IconProps) {
  return phosphor(ArrowCounterClockwise, props);
}

export function IconSafeArea(props: IconProps) {
  return phosphor(Selection, props);
}

export function IconChevron(props: IconProps) {
  return phosphor(CaretDown, props);
}

export function IconCheck(props: IconProps) {
  return phosphor(Check, props);
}

function BrandIcon({ size = 18, children, ...props }: IconProps & { children: ReactNode }) {
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

export function IconGoogle(props: IconProps) {
  return (
    <BrandIcon {...props}>
      <path d="M12 11.2v2.4h5.4A5.6 5.6 0 1 1 12 6.4a5.4 5.4 0 0 1 3.8 1.5l1.7-1.7A8 8 0 1 0 12 20a7.7 7.7 0 0 0 7.6-6 8 8 0 0 0 .2-1.8z" />
    </BrandIcon>
  );
}

export function IconDiscord(props: IconProps) {
  return (
    <BrandIcon {...props}>
      <path d="M8.2 8.8c1.6-.8 3.1-1.1 3.8-1.2l.4 1c1 .1 2 .4 3 .9 1.4 2 1.9 4.1 1.7 6.1-1.1.5-2.2.9-3.4 1.1l-.6-1.1c.4-.1.8-.3 1.1-.5-.3-.2-.6-.4-.9-.6-.9.4-1.9.6-2.9.6s-2-.2-2.9-.6c-.3.2-.6.4-.9.6.3.2.7.4 1.1.5l-.6 1.1c-1.2-.2-2.3-.6-3.4-1.1-.3-2.1.2-4.3 1.7-6.2.9-.4 1.8-.7 2.8-.8l.4-1c.7.1 2.2.4 3.8 1.2z" />
      <circle cx="9.4" cy="12.6" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.6" cy="12.6" r="1" fill="currentColor" stroke="none" />
    </BrandIcon>
  );
}

export function IconX(props: IconProps) {
  return (
    <BrandIcon {...props}>
      <path d="M5 5.5 10.8 12 5.2 18.5h2.2L12 13.4l4.4 5.1h2.4L12.8 11.8 18.8 5.5h-2.2L12 10.4 7.4 5.5z" />
    </BrandIcon>
  );
}

export function IconApple(props: IconProps) {
  return (
    <BrandIcon {...props}>
      <path d="M16.2 8.6c-.9 0-2 .6-2.6.6-.7 0-1.7-.6-2.8-.6-2.3.1-4.4 2-4.4 5.1 0 2 .7 4.1 1.7 5.5.8 1.1 1.6 2.2 2.8 2.2 1.1 0 1.5-.7 2.8-.7s1.6.7 2.8.7c1.2 0 1.9-1.1 2.7-2.2.8-1.2 1.1-2.4 1.1-2.5 0 0-2.2-.8-2.2-3.3 0-2.1 1.7-3 1.8-3.1-1-.1-2.2.6-2.7.6z" />
      <path d="M14.8 6.6c.6-.7 1-1.7.9-2.6-1 .1-2.1.7-2.7 1.5-.6.7-1 1.6-.9 2.5 1.1 0 2.1-.6 2.7-1.4z" />
    </BrandIcon>
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
