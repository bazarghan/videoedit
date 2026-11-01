import React from "react";
import { createRoot } from "react-dom/client";
import { DirectionProvider } from "@radix-ui/react-direction";
import App from "./App";
import { ConfirmProvider } from "./components/ui/confirm-dialog";
import "./index.css";
import "./telegram-editor/telegram-editor.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DirectionProvider dir="rtl">
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </DirectionProvider>
  </React.StrictMode>,
);
