"use client";

import { useEffect } from "react";
import PwaInstallPrompt from "./PwaInstallPrompt";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
      // SW asks the page to flush its offline outbox after a Background Sync tick
      const onMessage = (event: MessageEvent) => {
        if (event.data === "carespeak-flush-outbox") {
          window.dispatchEvent(new Event("online"));
        }
      };
      navigator.serviceWorker.addEventListener("message", onMessage);
      return () => navigator.serviceWorker.removeEventListener("message", onMessage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <PwaInstallPrompt />;
}
