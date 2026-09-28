import type { ComponentType, CSSProperties, SVGProps } from "react";
import {
  ArrowCounterClockwise,
  ArrowsOut,
  Bell,
  CaretDown,
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
  Gear,
  Headphones,
  Lock,
  LockOpen,
  MagnifyingGlass,
  PencilSimple,
  Play,
  Plus,
  Selection,
  ShareNetwork,
  ShieldCheck,
  SpeakerHigh,
  SpeakerSlash,
  Star,
  UploadSimple,
  User,
  type IconWeight,
} from "@phosphor-icons/react";
import navFriends from "../assets/nav/friends.png";
import navGames from "../assets/nav/games.png";
import navHome from "../assets/nav/home.png";
import navLibrary from "../assets/nav/library.png";
import navMessages from "../assets/nav/messages.png";
import navRecord from "../assets/nav/record.png";

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

function BrandGlyph({
  src,
  size = 18,
  className,
  color,
  painted = false,
}: {
  src: string;
  size?: number;
  className?: string;
  color?: string;
  painted?: boolean;
}) {
  if (painted) {
    return (
      <img
        src={src}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={["brand-glyph", "brand-glyph-painted", className].filter(Boolean).join(" ")}
      />
    );
  }
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: color || "currentColor",
    WebkitMaskImage: `url(${src})`,
    maskImage: `url(${src})`,
    WebkitMaskSize: "contain",
    maskSize: "contain",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
  };
  return <span aria-hidden="true" className={["brand-glyph", className].filter(Boolean).join(" ")} style={style} />;
}

export function IconHome(props: IconProps) {
  return <BrandGlyph src={navHome} size={props.size} className={props.className} color={props.color} />;
}

export function IconLibrary(props: IconProps) {
  return <BrandGlyph src={navLibrary} size={props.size} className={props.className} color={props.color} />;
}

export function IconRecord(props: IconProps) {
  return <BrandGlyph src={navRecord} size={props.size} className={props.className} painted />;
}

export function IconClips(props: IconProps) {
  return phosphor(FilmStrip, props);
}

export function IconExplore(props: IconProps) {
  return phosphor(Compass, props);
}

export function IconFriends(props: IconProps) {
  return <BrandGlyph src={navFriends} size={props.size} className={props.className} color={props.color} />;
}

export function IconMessages(props: IconProps) {
  return <BrandGlyph src={navMessages} size={props.size} className={props.className} color={props.color} />;
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
  return <BrandGlyph src={navGames} size={props.size} className={props.className} color={props.color} />;
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

export function IconPencil(props: IconProps) {
  return phosphor(PencilSimple, props);
}

export function IconShare(props: IconProps) {
  return phosphor(ShareNetwork, props);
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

export function IconGoogle({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className} {...props}>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export function IconDiscord({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className} {...props}>
      <path
        fill="#5865F2"
        d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"
      />
    </svg>
  );
}

export function IconX({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className} {...props}>
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}

export function IconApple({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className} {...props}>
      <path
        fill="currentColor"
        d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zm3.378-3.066c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z"
      />
    </svg>
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
