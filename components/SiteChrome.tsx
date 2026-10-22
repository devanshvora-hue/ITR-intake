import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

// The light header, page and footer of the home page and client portal
// (the CA workspace has its own shell). Rendered straight into <body>.
export function SiteChrome({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </>
  );
}
