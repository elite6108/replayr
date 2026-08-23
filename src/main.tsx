import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installDesktopTelemetry } from "./services/telemetry";
import "./styles/app.css";

installDesktopTelemetry();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
