import { SiteChrome } from "@/components/SiteChrome";

// The client portal keeps the light site frame and palette.
export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return <SiteChrome>{children}</SiteChrome>;
}
