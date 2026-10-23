import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

// The light site frame (home page, client portal, not found); the CA workspace
// has its own dark shell. .theme-site scopes the light palette to this subtree.
export function SiteChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="theme-site flex flex-1 flex-col bg-paper text-ink">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
