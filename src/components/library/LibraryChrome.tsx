import type { ReactNode } from "react";
import { LibraryTabs } from "./LibraryTabs";

export function LibraryChrome({ trailing }: { trailing?: ReactNode }) {
  return (
    <header className="library-head">
      <div className="library-head-copy">
        <h1>Library</h1>
        <p>Your captured moments, organized beautifully.</p>
      </div>
      <div className="library-tabrow">
        <LibraryTabs />
        {trailing}
      </div>
    </header>
  );
}
