import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
});

// Small labels and codes only: not preloaded, so it never competes with the
// text and headline fonts for first paint. Its size-adjusted fallback keeps
// the swap from shifting layout.
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  preload: false,
});

// Fraunces (the light pages' display face) is loaded by components/SiteChrome,
// so the dark CA workspace, which does not use it, never downloads it.

export const metadata: Metadata = {
  title: "ITR Intake",
  description:
    "Client intake and bank-statement review for Indian CA firms: collect statements and documents, review every transaction, and prepare an ITR summary workbook.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en-IN"
      className={`${plexSans.variable} ${plexMono.variable}`}
    >
      {/* Each area brings its own frame: the light SiteChrome (home, client
          portal, not found) or the dark CaShell (app/ca/layout.tsx). */}
      <body className="flex min-h-screen flex-col font-sans antialiased">{children}</body>
    </html>
  );
}
