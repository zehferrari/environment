"use client";

import { useEffect } from "react";
import {
  isLikelyStaleBuildError,
  requestStaleBuildReload,
} from "@/lib/client/stale-build";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const staleBuild = isLikelyStaleBuildError(error);

  useEffect(() => {
    if (staleBuild) requestStaleBuildReload(error);
  }, [error, staleBuild]);

  return (
    <html lang="en">
      <body style={{
        margin: 0,
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#f6f7f9",
        color: "#18202f",
        fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      }}>
        <main style={{
          width: "min(92vw, 34rem)",
          border: "1px solid #d9dee7",
          borderRadius: "8px",
          background: "#ffffff",
          padding: "24px",
          boxShadow: "0 18px 50px rgba(15, 23, 42, 0.12)",
        }}>
          <p style={{
            margin: "0 0 8px",
            fontSize: "12px",
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "#667085",
          }}>
            Zero Latency
          </p>
          <h1 style={{ margin: 0, fontSize: "24px", lineHeight: 1.2 }}>
            {staleBuild ? "Refreshing the app" : "Application error"}
          </h1>
          <p style={{ margin: "12px 0 0", color: "#4b5565", lineHeight: 1.6 }}>
            {staleBuild
              ? "A stale app asset failed to load after a deploy. The page should refresh automatically."
              : "The app hit a client-side error. Try again or reload the page."}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginTop: "20px" }}>
            <button
              type="button"
              onClick={reset}
              style={{
                border: "1px solid #cbd5e1",
                borderRadius: "8px",
                background: "#ffffff",
                color: "#18202f",
                padding: "9px 12px",
                font: "inherit",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                border: "1px solid #2563eb",
                borderRadius: "8px",
                background: "#2563eb",
                color: "#ffffff",
                padding: "9px 12px",
                font: "inherit",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
