/** YYYY-MM-DD in an IANA timezone. Invalid zones fall back to the UTC date. */
export function localDateInTimeZone(now: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (!year || !month || !day) return utcDate(now);
    return `${year}-${month}-${day}`;
  } catch {
    return utcDate(now);
  }
}

export function addIsoDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/** Inclusive local dates from `end - (days - 1)` through `end`, oldest first. */
export function datesEnding(end: string, days: number): string[] {
  const dates: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) dates.push(addIsoDays(end, -offset));
  return dates;
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}
