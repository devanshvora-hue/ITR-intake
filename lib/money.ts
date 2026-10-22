// Display formatting for exact decimal amounts from the API ("123456.78"), in
// Indian grouping: "₹1,23,456.78". Works on the text, never through floating
// point, so the shown figure is exactly the stored one.

export function formatInr(value: string | null | undefined, { blankZero = false } = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return value;
  const [, sign, whole, fraction = ""] = m;
  if (blankZero && /^0+$/.test(whole) && /^0*$/.test(fraction)) return "—";
  const digits = whole.replace(/^0+(?=\d)/, "");
  const last3 = digits.slice(-3), rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${sign ?? ""}₹${grouped}.${fraction.padEnd(2, "0")}`;
}
