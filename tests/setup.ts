// Shared test setup. next/font only works inside the Next.js compiler; tests
// render components that load fonts (SiteChrome loads Fraunces), and only need
// the class and variable names, so each font loader the app uses is a stub.

import { vi } from "vitest";

vi.mock("next/font/google", () => {
  const font = (name: string) => () => ({ className: `font-${name}`, variable: `font-${name}-variable`, style: {} });
  return { Fraunces: font("fraunces"), IBM_Plex_Sans: font("plex-sans"), IBM_Plex_Mono: font("plex-mono") };
});
