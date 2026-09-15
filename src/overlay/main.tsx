import React from "react";
import ReactDOM from "react-dom/client";
import { ClipSavedOverlay } from "../components/overlay/ClipSavedOverlay";
import "../styles/overlay.css";

if (new URLSearchParams(window.location.search).has("preview")) {
  document.documentElement.classList.add("preview");
}

// Rendered once. This previously created two roots on the same element, mounting the overlay
// (and its event listeners) twice.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClipSavedOverlay />
  </React.StrictMode>,
);
