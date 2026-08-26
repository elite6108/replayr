import React from "react";
import ReactDOM from "react-dom/client";
import { ClipSavedOverlay } from "../components/overlay/ClipSavedOverlay";
import "../styles/overlay.css";

if (new URLSearchParams(window.location.search).has("preview")) {
  document.documentElement.classList.add("preview");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClipSavedOverlay />
  </React.StrictMode>,
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClipSavedOverlay />
  </React.StrictMode>,
);
