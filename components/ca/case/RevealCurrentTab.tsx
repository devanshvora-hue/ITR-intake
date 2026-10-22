"use client";

import { useEffect, useRef } from "react";

// When the case tab bar scrolls sideways (narrow phones), bring the current
// tab into view. Scrolls only the bar, never the page. Renders nothing visible.
export function RevealCurrentTab() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const bar = marker.current?.parentElement?.querySelector("ul");
    const current = bar?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!bar || !current || bar.scrollWidth <= bar.clientWidth) return;
    // Screen positions, so the bar's current scroll offset needs no special handling.
    const box = bar.getBoundingClientRect();
    const tab = current.getBoundingClientRect();
    if (tab.left < box.left || tab.right > box.right) {
      bar.scrollLeft += tab.left - box.left - (box.width - tab.width) / 2;
    }
  });
  return <span ref={marker} hidden />;
}
