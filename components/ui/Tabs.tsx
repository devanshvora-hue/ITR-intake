"use client";

import { useRef } from "react";

export type TabItem<K extends string> = { key: K; label: React.ReactNode };

/**
 * The tab a key press moves to, or null for keys the tab list ignores.
 * Arrows wrap around; Home and End jump to the first and last tab.
 */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

const tabClass = (selected: boolean) =>
  `rounded-full border px-3 py-1 text-xs font-medium ${selected
    ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-soft hover:border-ink-faint"}`;

/**
 * A controlled tab list (WAI-ARIA tabs, automatic activation). Only the selected
 * tab is in the Tab order; arrow keys, Home and End move between tabs. Render the
 * selected content in a <TabPanel> with the same idPrefix.
 */
export function Tabs<K extends string>({ label, idPrefix, items, value, onChange, className }: {
  label: string;
  idPrefix: string;
  items: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const target = tabKeyTarget(event.key, index, items.length);
    if (target === null) return;
    event.preventDefault();
    onChange(items[target].key);
    refs.current[target]?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className={className ?? "flex flex-wrap gap-1.5"}>
      {items.map((item, index) => {
        const selected = item.key === value;
        return (
          <button
            key={item.key}
            ref={(el) => { refs.current[index] = el; }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.key}`}
            aria-selected={selected}
            aria-controls={selected ? `${idPrefix}-panel-${item.key}` : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={tabClass(selected)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idPrefix, tabKey, className, children }: {
  idPrefix: string;
  tabKey: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${tabKey}`} aria-labelledby={`${idPrefix}-tab-${tabKey}`} tabIndex={0}
         className={className}>
      {children}
    </div>
  );
}
