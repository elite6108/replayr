import React from "react";
import ReactDOM from "react-dom/client";
import { ClipSavedOverlay } from "../components/overlay/ClipSavedOverlay";
import "../styles/overlay.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClipSavedOverlay />
  </React.StrictMode>,
);
