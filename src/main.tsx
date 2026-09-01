import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installDesktopAnalytics } from "./services/analytics";
import { installDesktopTelemetry } from "./services/telemetry";
import "./styles/app.css";

installDesktopTelemetry();
void installDesktopAnalytics();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
