import type { HTMLAttributes } from "react";

/** The bordered, rounded surface used for page sections. Adds no padding or spacing of its own. */
export function Card({ as: Tag = "div", className, ...rest }: HTMLAttributes<HTMLElement> & {
  as?: "div" | "section" | "article" | "aside" | "li";
}) {
  const classes = "rounded-2xl border border-line bg-surface";
  return <Tag {...rest} className={className ? `${classes} ${className}` : classes} />;
}
