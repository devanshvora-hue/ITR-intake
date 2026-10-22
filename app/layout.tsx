import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-fraunces",
});

export const metadata: Metadata = {
  title: "ITR Intake",
  description:
    "Prototype client onboarding and document collection for Indian CA firms.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en-IN"
      className={`${plexSans.variable} ${plexMono.variable} ${fraunces.variable}`}
    >
      {/* Each area brings its own frame: the light SiteChrome (home, client
          portal, not found) or the dark CaShell (app/ca/layout.tsx). */}
      <body className="flex min-h-screen flex-col font-sans antialiased">{children}</body>
    </html>
  );
}
