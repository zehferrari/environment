import Link from "next/link";
import NotFoundRecovery from "@/components/not-found-recovery";

// Root fallback 404 (renders inside the root layout). Client soft-navigation
// 404s that resolve on a full load are recovered by NotFoundRecovery (reload
// once); a genuine 404 shows the message below.
export default function RootNotFound() {
  return (
    <NotFoundRecovery>
      <div style={{ minHeight: "60vh", display: "grid", placeItems: "center", padding: "24px" }}>
        <div
          style={{
            width: "min(92vw, 28rem)",
            border: "1px solid #d9dee7",
            borderRadius: "12px",
            background: "#ffffff",
            padding: "24px",
            textAlign: "center",
            boxShadow: "0 1px 3px rgba(20,31,55,0.07)",
          }}
        >
          <p style={{ margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#667085" }}>
            Mission Control
          </p>
          <h1 style={{ margin: "4px 0 0", fontSize: 20 }}>Not found</h1>
          <p style={{ margin: "8px 0 16px", color: "#4b5565", lineHeight: 1.6 }}>
            This page doesn’t exist, or the item was moved or removed.
          </p>
          <Link
            href="/workspaces"
            style={{
              display: "inline-block",
              border: "1px solid #2563eb",
              borderRadius: "8px",
              background: "#2563eb",
              color: "#ffffff",
              padding: "9px 12px",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Go to boards
          </Link>
        </div>
      </div>
    </NotFoundRecovery>
  );
}
