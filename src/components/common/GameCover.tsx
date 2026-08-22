import { useEffect, useState } from "react";

export function GameCover({ name, coverUrl }: { name: string; coverUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [coverUrl]);
  if (coverUrl && !failed) {
    return <img className="game-cover" src={coverUrl} alt="" onError={() => setFailed(true)} />;
  }
  return (
    <span className="game-cover fallback" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
