export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function localDateISO(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(dateISO: string, days: number): string {
  const date = parseLocalDate(dateISO);
  date.setDate(date.getDate() + days);
  return localDateISO(date);
}

export function parseLocalDate(dateISO: string): Date {
  const [year, month, day] = dateISO.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function atLocalTime(dateISO: string, hours: number, minutes: number): string {
  const date = parseLocalDate(dateISO);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

/** Sunday-start week, matching the Log mockup. */
export function startOfWeek(dateISO: string): string {
  const date = parseLocalDate(dateISO);
  return addDays(dateISO, -date.getDay());
}

export function formatCompactTime(iso: string): string {
  const date = new Date(iso);
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const suffix = date.getHours() >= 12 ? "p" : "a";
  const hour = date.getHours() % 12 || 12;
  return `${hour}:${minutes}${suffix}`;
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

export function weekdayLetter(dateISO: string): string {
  return WEEKDAYS[parseLocalDate(dateISO).getDay()];
}

export function dayNumber(dateISO: string): string {
  return String(parseLocalDate(dateISO).getDate());
}

export function formatHeading(dateISO: string, today = localDateISO()): string {
  if (dateISO === today) return "Today";
  return parseLocalDate(dateISO).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function formatReviewDate(dateISO: string, today = localDateISO()): string {
  if (dateISO === today) return "Today";
  if (dateISO === addDays(today, -1)) return "Yesterday";
  return parseLocalDate(dateISO).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
