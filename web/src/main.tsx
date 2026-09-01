import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { captureWebAttribution } from "./lib/attribution";
import { installWebTelemetry } from "./lib/telemetry";
import "./styles.css";

installWebTelemetry();
captureWebAttribution();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
