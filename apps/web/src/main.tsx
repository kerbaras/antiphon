import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { AuthRoot } from "./auth/auth-root";
import "./styles.css";

// biome-ignore lint/style/noNonNullAssertion: root element is in index.html
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* ClerkProvider mounts at the root iff the server enforces auth;
        keyless renders the app bare. */}
    <AuthRoot>
      <App />
    </AuthRoot>
  </StrictMode>,
);
