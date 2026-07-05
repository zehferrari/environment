"use client";

import { useEffect } from "react";
import {
  clearStaleBuildReloadMarker,
  isLikelyStaleBuildError,
  requestStaleBuildReload,
} from "@/lib/client/stale-build";

function isNextStaticAsset(url: string | null | undefined) {
  return Boolean(url && url.includes("/_next/static/"));
}

function isNextAssetLoadError(event: Event) {
  const target = event.target;
  if (target instanceof HTMLScriptElement) {
    return isNextStaticAsset(target.src);
  }
  if (target instanceof HTMLLinkElement) {
    return isNextStaticAsset(target.href);
  }
  return false;
}

export default function StaleBuildRecovery() {
  useEffect(() => {
    clearStaleBuildReloadMarker();

    const onError = (event: ErrorEvent) => {
      if (isNextAssetLoadError(event) || isLikelyStaleBuildError(event.error ?? event.message)) {
        requestStaleBuildReload(event.error ?? event.message ?? "next asset load failed");
      }
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isLikelyStaleBuildError(event.reason)) {
        requestStaleBuildReload(event.reason);
      }
    };

    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
