import { CaShell } from "@/components/ca/CaShell";

// Every /ca route (dashboard, case pages and the CA sign-in pages) renders in
// the dark CA workspace. Access checks stay in the pages and the API.
export default function CaLayout({ children }: { children: React.ReactNode }) {
  return <CaShell>{children}</CaShell>;
}
