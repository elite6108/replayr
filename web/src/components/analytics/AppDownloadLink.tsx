import { trackAppDownloadClick, type DownloadPlatform, type DownloadSurface } from "../../lib/analytics";

type Props = {
  href: string;
  platform: DownloadPlatform;
  surface: DownloadSurface;
  className?: string;
  children: React.ReactNode;
  onClick?: () => void;
};

export function AppDownloadLink({ href, platform, surface, className, children, onClick }: Props) {
  return (
    <a
      className={className}
      href={href}
      onClick={() => {
        trackAppDownloadClick({ platform, surface });
        onClick?.();
      }}
    >
      {children}
    </a>
  );
}
