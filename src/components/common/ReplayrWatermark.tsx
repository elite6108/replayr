import type { ReactNode } from "react";
import watermarkLogo from "../../assets/replayr-watermark.png";

export function ReplayrWatermark({ show }: { show: boolean }) {
  if (!show) return null;
  return <img className="clip-watermark" src={watermarkLogo} alt="" aria-hidden="true" />;
}

export function PlayerVideo({
  showWatermark,
  children,
}: {
  showWatermark: boolean;
  children: ReactNode;
}) {
  return (
    <div className="player-video-wrap">
      {children}
      <div className="player-video-mark">
        <ReplayrWatermark show={showWatermark} />
      </div>
    </div>
  );
}
