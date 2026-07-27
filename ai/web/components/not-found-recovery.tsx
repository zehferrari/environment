"use client";

// A client-side navigation that 404s but loads fine on a hard refresh is a
// stale client build (deployment skew) or an interception/parallel-slot miss —
// in every such case a full load (what a hard refresh is) resolves the route.
// So on a rendered 404 we reload once per URL per tab session; a genuine 404
// survives that reload (the marker is set) and its content is shown, no loop.

import { useEffect, useState } from "react";

const PREFIX = "pm:notfound-recover:v1:";

export default function NotFoundRecovery({ children }: { children: React.ReactNode }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let store: Storage | null = null;
    try {
      store = window.sessionStorage;
    } catch {
      store = null;
    }
    const key = PREFIX + window.location.pathname;
    if (store && store.getItem(key) !== "1") {
      store.setItem(key, "1");
      window.location.reload();
      return;
    }
    // No sessionStorage, or we already reloaded and it's still 404 → it's real.
    setShow(true);
  }, []);

  // While the one-shot reload is in flight, render nothing (avoids a 404 flash).
  return show ? <>{children}</> : null;
}
