import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";

import { App } from "@/sidepanel/App";
import { AppProvider } from "@/sidepanel/state";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/styles/globals.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProvider>
      <TooltipProvider delayDuration={200}>
        <App />
        <Toaster position="bottom-center" richColors closeButton theme="system" />
      </TooltipProvider>
    </AppProvider>
  </React.StrictMode>,
);
