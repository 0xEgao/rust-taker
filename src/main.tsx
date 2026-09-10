import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Keys earlier versions wrote and no longer do. `coinswap_connectivity_defaults` carried the
// node's RPC username and password and the Tor control password in plaintext, so ceasing to
// write it left whatever a user had entered sitting in the webview's store forever. Rust does
// the same for its own retired file in `chain_backend::remove_legacy_config`.
for (const key of ["coinswap_connectivity_defaults"]) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage unavailable means there is nothing persisted to clean up.
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
