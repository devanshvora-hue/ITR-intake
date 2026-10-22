// The form primitives now live in components/ui; CA and client forms keep
// importing them from here.
import { buttonClasses } from "@/components/ui/Button";

export { Field } from "@/components/ui/Field";
export { FormMessage } from "@/components/ui/FormMessage";

/** The full-width primary form button (and the link styled like it). */
export const primaryButton = `${buttonClasses({ variant: "primary", size: "lg" })} w-full`;
