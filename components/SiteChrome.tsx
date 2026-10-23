import { Fraunces } from "next/font/google";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

// The light pages' display face. Loaded here rather than in the root layout, so
// it is preloaded only on routes that render this frame. .theme-site maps
// --font-serif to it.
const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-fraunces",
});

// The light site frame (home page, client portal, not found); the CA workspace
// has its own dark shell. .theme-site scopes the light palette to this subtree.
export function SiteChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${fraunces.variable} theme-site flex flex-1 flex-col bg-paper text-ink`}>
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
