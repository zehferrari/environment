import type { Metadata } from "next";
import StaleBuildRecovery from "@/components/stale-build-recovery";
import { getSystemSettings, type SystemTheme } from "@/lib/settings/system";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zero Latency — Mission Control",
  description: "Zero Latency — Mission Control for zehferrari/environment",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const theme = await rootTheme();
  return (
    <html lang="en" data-theme={theme}>
      <body>
        <StaleBuildRecovery />
        {children}
      </body>
    </html>
  );
}

async function rootTheme(): Promise<SystemTheme> {
  if (!process.env.DATABASE_URL) return "light";
  try {
    const settings = await getSystemSettings();
    return settings.theme;
  } catch {
    return "light";
  }
}
