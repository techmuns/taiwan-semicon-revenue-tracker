/**
 * Formatters.
 *
 * The rule this file exists to enforce: **null renders as an em dash, never as
 * 0, never as "0.0%", never as an empty string.** The API goes to some trouble
 * to keep "did not file" distinct from "earned nothing"; a formatter that prints
 * 0 for null throws that away at the last possible moment, in the one place a
 * reader would never think to check.
 *
 * Revenue arrives in TWD thousands. It is never shown raw - eleven digits in a
 * table cell cannot be compared by eye - so it is scaled to NT$bn/m with the
 * unit attached to the number.
 */

/** What a missing figure looks like. One constant so it cannot drift. */
export const NA = "—";

export function isMissing(value: number | null | undefined): boolean {
  return value === null || value === undefined || Number.isNaN(value);
}

/**
 * Revenue, from TWD thousands to a readable magnitude.
 *
 * 1 thousand TWD * 1e6 = 1e9 TWD = NT$1bn, so the bn divisor is 1e6.
 */
export function revenue(twdThousands: number | null | undefined): string {
  if (isMissing(twdThousands)) return NA;
  const v = twdThousands as number;
  const abs = Math.abs(v);
  if (abs >= 1e6) return `NT$${(v / 1e6).toFixed(2)}bn`;
  if (abs >= 1e3) return `NT$${(v / 1e3).toFixed(1)}m`;
  return `NT$${v.toFixed(0)}k`;
}

/** Full precision, for tooltips and the drilldown - thousands with separators. */
export function revenueExact(twdThousands: number | null | undefined): string {
  if (isMissing(twdThousands)) return NA;
  return `${(twdThousands as number).toLocaleString("en-US")} k`;
}

/** A percentage. Signed, because the sign is the point. */
export function pct(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return NA;
  const v = value as number;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** Percentage points - acceleration. Unit is "ppt", not "%", and it matters. */
export function ppt(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return NA;
  const v = value as number;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)} ppt`;
}

/** Bare signed number, for dense cells where the unit is in the legend. */
export function signed(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return NA;
  const v = value as number;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

/** "2026-07" -> "Jul 2026". Parsed as a plain string; no Date, no timezone. */
export function monthLabel(month: string): string {
  const parts = month.split("-");
  const year = parts[0] ?? month;
  const mm = Number(parts[1]);
  const names = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const name = mm >= 1 && mm <= 12 ? names[mm - 1] : undefined;
  return name ? `${name} ${year}` : month;
}

/** "2026-07" -> "Jul" - for dense axes where the year is in the header. */
export function monthShort(month: string): string {
  return monthLabel(month).split(" ")[0] ?? month;
}

/** An ISO instant as a compact UTC stamp. Empty stays empty, not "Invalid Date". */
export function utcStamp(iso: string | null | undefined): string {
  if (!iso) return NA;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/** Hours since an instant, for freshness. Null when unparseable. */
export function hoursSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now - t) / 3_600_000;
}

export function freshnessLabel(iso: string | null | undefined, now: number): string {
  const h = hoursSince(iso, now);
  if (h === null) return NA;
  if (h < 1) return "under 1h ago";
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
