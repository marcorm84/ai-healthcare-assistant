import { config } from "./config.js";
import { weekdayOf } from "./format.js";

/** The clinic-local calendar date (YYYY-MM-DD) for an ISO timestamp. */
export function clinicDate(iso: string, timeZone: string = config.clinicTimeZone): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

export interface ClinicParts {
  /** Clinic-local calendar date, YYYY-MM-DD. */
  date: string;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
}

/** Clinic-local date, weekday and time for an ISO timestamp (DST-safe via Intl). */
export function clinicParts(iso: string, timeZone: string = config.clinicTimeZone): ClinicParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const get = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const date = `${get.year}-${get.month}-${get.day}`;
  return { date, weekday: weekdayOf(date), minutes: Number(get.hour) * 60 + Number(get.minute) };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Offset of `timeZone` from UTC, in ms, at the instant `utcMs`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const g = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((p) => [p.type, Number(p.value)]));
  return Date.UTC(g.year!, g.month! - 1, g.day!, g.hour!, g.minute!, g.second!) - Math.floor(utcMs / 1000) * 1000;
}

/**
 * "2026-11-07T10:00" (wall-clock time at the clinic) -> "2026-11-07T10:00:00-08:00".
 * Handles daylight saving. Returns null for anything that isn't a real date/time.
 */
export function clinicLocalToIso(local: string, timeZone: string = config.clinicTimeZone): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  let offset = zoneOffsetMs(wall, timeZone);
  const settled = zoneOffsetMs(wall - offset, timeZone);
  if (settled !== offset) offset = settled; // the wall time straddles a DST change
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset) / 60000;
  return `${m[1]}-${m[2]}-${m[3]}T${pad2(h)}:${pad2(mi)}:${pad2(s)}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}
