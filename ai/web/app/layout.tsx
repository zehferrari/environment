import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zero Latency — Mission Control",
  description: "Zero Latency — Mission Control for zehferrari/environment",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
