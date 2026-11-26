const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export const weekdayName = (weekday: number) => WEEKDAYS[weekday] ?? "";

function parts(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y: y ?? 0, m: m ?? 0, d: d ?? 0 };
}

/** 0 = Sunday ... 6 = Saturday, for a calendar date (YYYY-MM-DD). */
export function weekdayOf(date: string): number {
  const { y, m, d } = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const { y, m, d } = parts(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "Tuesday, November 10" (the year is added only when it differs from `today`'s). */
export function longDate(date: string, today?: string): string {
  const { y, m, d } = parts(date);
  const year = today && parts(today).y === y ? "" : `, ${y}`;
  return `${weekdayName(weekdayOf(date))}, ${MONTHS[m - 1]} ${d}${year}`;
}

/** "09:30" -> "9:30 a.m.", "17:00" -> "5:00 p.m." */
export function formatTime(hhmm: string): string {
  const [h = 0, min = 0] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "p.m." : "a.m.";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(min).padStart(2, "0")} ${suffix}`;
}

export const formatMoney = (n: number) => `$${n.toFixed(2)}`;

export const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
