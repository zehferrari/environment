"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// ENV-110 Command Deck: the widget panel chunk is only fetched once the
// viewport actually crosses 3440px, so sub-5xl clients pay no JS or data
// cost for the rail.
const CommandDeckPanel = dynamic(() => import("./command-deck-panel"), {
  ssr: false,
});

export default function CommandDeck() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 3440px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return (
    <aside
      aria-label="Command deck"
      className="hidden w-[22.5rem] shrink-0 border-l border-line bg-bg-elev/60 5xl:block"
    >
      {wide ? <CommandDeckPanel /> : null}
    </aside>
  );
}
