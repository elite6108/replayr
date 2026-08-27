import { forwardRef, type ReactNode } from "react";
import watermarkLogo from "../../assets/replayr-watermark.png";

export function ReplayrWatermark({ show }: { show: boolean }) {
  if (!show) return null;
  return <img className="clip-watermark" src={watermarkLogo} alt="" aria-hidden="true" />;
}

export const PlayerVideo = forwardRef<
  HTMLDivElement,
  {
    showWatermark: boolean;
    children: ReactNode;
    className?: string;
  }
>(function PlayerVideo({ showWatermark, children, className }, ref) {
  return (
    <div ref={ref} className={className ? `player-video-wrap ${className}` : "player-video-wrap"}>
      {children}
      <div className="player-video-mark">
        <ReplayrWatermark show={showWatermark} />
      </div>
    </div>
  );
});
