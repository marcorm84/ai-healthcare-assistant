import { addDays, weekdayName, weekdayOf } from "../format.js";
import { clinicParts } from "../time.js";

export interface Hours {
  /** Weekdays the clinic is open, 0 = Sunday. */
  days: number[];
  open: string; // HH:MM, 24h
  close: string;
  /** Label as written in the FAQ, e.g. "Pacific". */
  zone: string;
  closedOnFederalHolidays: boolean;
}

const DAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const to24 = (h: string, m: string, ap: string) =>
  `${String((Number(h) % 12) + (ap.toLowerCase() === "p" ? 12 : 0)).padStart(2, "0")}:${m}`;

/** Parses the FAQ line, e.g. "Monday–Friday, 9:00 a.m.–5:00 p.m. Pacific. Closed weekends and federal holidays." */
export function parseHours(text: string): Hours {
  const m = /^(\w+)\s*[–-]\s*(\w+),\s*(\d{1,2}):(\d{2})\s*([ap])\.m\.\s*[–-]\s*(\d{1,2}):(\d{2})\s*([ap])\.m\.\s*(\w+)/i.exec(text.trim());
  const from = DAY_INDEX[m?.[1]?.toLowerCase() ?? ""];
  const to = DAY_INDEX[m?.[2]?.toLowerCase() ?? ""];
  if (!m || from === undefined || to === undefined || from > to) {
    throw new Error(`Could not parse clinic hours from the FAQ: "${text}"`);
  }
  return {
    days: Array.from({ length: to - from + 1 }, (_, i) => from + i),
    open: to24(m[3]!, m[4]!, m[5]!),
    close: to24(m[6]!, m[7]!, m[8]!),
    zone: m[9]!,
    closedOnFederalHolidays: /federal holidays/i.test(text),
  };
}

// ---- US federal holidays (computed, with weekend observance) ----------------

const pad = (n: number) => String(n).padStart(2, "0");

function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = weekdayOf(`${year}-${pad(month)}-01`);
  return `${year}-${pad(month)}-${pad(1 + ((weekday - first + 7) % 7) + (n - 1) * 7)}`;
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = weekdayOf(`${year}-${pad(month)}-${pad(last)}`);
  return `${year}-${pad(month)}-${pad(last - ((lastDow - weekday + 7) % 7))}`;
}

/** Observed date: Saturday -> Friday before, Sunday -> Monday after. */
function observed(date: string): string {
  const w = weekdayOf(date);
  return w === 6 ? addDays(date, -1) : w === 0 ? addDays(date, 1) : date;
}

function holidaysOf(year: number): [string, string][] {
  return [
    [observed(`${year}-01-01`), "New Year's Day"],
    [nthWeekday(year, 1, 1, 3), "Martin Luther King Jr. Day"],
    [nthWeekday(year, 2, 1, 3), "Presidents' Day"],
    [lastWeekday(year, 5, 1), "Memorial Day"],
    [observed(`${year}-06-19`), "Juneteenth"],
    [observed(`${year}-07-04`), "Independence Day"],
    [nthWeekday(year, 9, 1, 1), "Labor Day"],
    [nthWeekday(year, 10, 1, 2), "Columbus Day"],
    [observed(`${year}-11-11`), "Veterans Day"],
    [nthWeekday(year, 11, 4, 4), "Thanksgiving"],
    [observed(`${year}-12-25`), "Christmas Day"],
  ];
}

/** Name of the federal holiday observed on `date`, or null. */
export function federalHoliday(date: string): string | null {
  const year = Number(date.slice(0, 4));
  // Jan 1 of next year can be observed on Dec 31 of this one.
  const all = [...holidaysOf(year), ...holidaysOf(year + 1)];
  return all.find(([d]) => d === date)?.[1] ?? null;
}

// ---- Open / closed ----------------------------------------------------------

/** Why the clinic is closed all day on `date`, or null if it is a normal open day. */
export function closedAllDayReason(hours: Hours, date: string): string | null {
  const weekday = weekdayOf(date);
  const holiday = hours.closedOnFederalHolidays ? federalHoliday(date) : null;
  if (holiday) return `${holiday}, a federal holiday`;
  if (!hours.days.includes(weekday)) {
    return weekday === 0 || weekday === 6 ? "it's a weekend" : `we're not open on ${weekdayName(weekday)}s`;
  }
  return null;
}

export interface NextOpen {
  date: string;
  open: string;
}

export function nextOpenAfter(hours: Hours, date: string): NextOpen {
  for (let i = 1; i <= 14; i++) {
    const d = addDays(date, i);
    if (!closedAllDayReason(hours, d)) return { date: d, open: hours.open };
  }
  throw new Error("No open day found in the next 14 days");
}

export type OpenStatus =
  | { kind: "open"; date: string; closes: string }
  | { kind: "before_open"; date: string; opens: string; closes: string }
  | { kind: "after_close"; date: string; closed_at: string; next: NextOpen }
  | { kind: "closed_day"; date: string; reason: string; next: NextOpen };

/** Open/closed state at a scenario instant, in the clinic's time zone. */
export function statusAt(hours: Hours, iso: string): OpenStatus {
  const { date, minutes } = clinicParts(iso);
  const reason = closedAllDayReason(hours, date);
  if (reason) return { kind: "closed_day", date, reason, next: nextOpenAfter(hours, date) };
  const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  if (minutes < mins(hours.open)) return { kind: "before_open", date, opens: hours.open, closes: hours.close };
  if (minutes >= mins(hours.close)) {
    return { kind: "after_close", date, closed_at: hours.close, next: nextOpenAfter(hours, date) };
  }
  return { kind: "open", date, closes: hours.close };
}
