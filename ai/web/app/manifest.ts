import type { MetadataRoute } from "next";

// Web App Manifest — makes agents.vixi.au installable as a PWA. Installability
// is also what unlocks reliable closed-app Web Push on mobile (notably iOS,
// which only delivers push to home-screen-installed web apps).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Vixi PM — Agents",
    short_name: "Vixi PM",
    description: "Chat with your OpenClaw agents and manage work items.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b0f17",
    theme_color: "#0b0f17",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
