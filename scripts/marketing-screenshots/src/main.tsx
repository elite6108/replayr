import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "../../../src/App";
import { useSettingsStore } from "../../../src/stores/settingsStore";
import { seedMarketingSession } from "./seed";
import "../../../src/styles/app.css";

function MarketingBoot() {
  const loaded = useSettingsStore((state) => state.loaded);

  useEffect(() => {
    if (!loaded) return;
    seedMarketingSession();
    const mark = () => {
      document.documentElement.dataset.marketingReady = "1";
    };
    const id = window.setTimeout(mark, 80);
    return () => window.clearTimeout(id);
  }, [loaded]);

  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<MarketingBoot />);
