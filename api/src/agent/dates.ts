import type { OpenSlot } from "../domain/schemas.js";
import { addDays, weekdayOf } from "../format.js";
import { flags } from "./flags.js";

/**
 * Turns "Tuesday afternoon", "Nov 12 at 2pm", "the second one" into structure.
 * Pure and deterministic; "today" is always passed in (the scenario clock).
 */
export type Window = "morning" | "afternoon" | "evening" | "any";

export interface Schedule {
  /** Clinic-local date, YYYY-MM-DD. */
  date?: string;
  /** The date was understood but is before today. */
  past?: boolean;
  window?: Window;
  /** HH:MM, 24h. */
  time?: string;
  /** Set only when the message identifies one of the open slots. */
  slot?: OpenSlot;
  /** "next week", "soon": a timeframe without a day. */
  vague?: boolean;
  hasInfo: boolean;
}

export interface ScheduleContext {
  today: string;
  /** All future open slots (used to prefer weekdays that have openings and to match times). */
  openSlots: OpenSlot[];
  /** Slots we last listed to the patient, in the order shown ("the second one"). */
  suggested: OpenSlot[];
  /** The date of the request being changed, so "the following Monday" means the Monday after it. */
  anchor?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthNumber = (name: string) => MONTH_INDEX[name.slice(0, 3)] ?? 0;

const WEEKDAYS: [RegExp, number][] = [
  [/\bsunday\b/, 0], [/\bmon(?:day)?\b/, 1], [/\btue(?:s|sday)?\b/, 2], [/\bwed(?:nesday)?\b/, 3],
  [/\bthu(?:r|rs|rsday)?\b/, 4], [/\bfri(?:day)?\b/, 5], [/\bsaturday\b/, 6],
];

function realDate(y: number, m: number, d: number): string | null {
  const s = `${y}-${pad(m)}-${pad(d)}`;
  const dt = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s ? s : null;
}

/** Month/day without a year: this year, or next year if it is long past (so "January 14" in November works). */
function monthDay(m: number, d: number, today: string, year?: number): string | null {
  const y = year ?? Number(today.slice(0, 4));
  const cand = realDate(y, m, d);
  if (!cand) return null;
  if (year === undefined && cand < addDays(today, -60)) return realDate(y + 1, m, d);
  return cand;
}

function explicitDate(t: string, today: string): string | null {
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return realDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`).exec(t);
  if (m) return monthDay(monthNumber(m[1]!), Number(m[2]), today, m[3] ? Number(m[3]) : undefined);
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`).exec(t);
  if (m) return monthDay(monthNumber(m[2]!), Number(m[1]), today);
  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    return monthDay(Number(m[1]), Number(m[2]), today, year);
  }
  m = /\bthe (\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (m) {
    const d = Number(m[1]);
    const [y, mo] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const here = realDate(y, mo, d);
    if (here && here >= today) return here;
    return mo === 12 ? realDate(y + 1, 1, d) : realDate(y, mo + 1, d);
  }
  return null;
}

function relativeDate(t: string, today: string): string | null {
  if (/\bday after tomorrow\b/.test(t)) return addDays(today, 2);
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  if (/\btoday\b/.test(t)) return today;
  return null;
}

/**
 * A weekday name resolves to a date that is *after* today. Prefer the nearest one
 * that has open slots (so "Thursday" means the Thursday we actually offered);
 * "next Thursday" means the week after this one.
 */
function weekdayDate(t: string, ctx: ScheduleContext): string | null {
  for (const [re, target] of WEEKDAYS) {
    const m = re.exec(t);
    if (!m) continue;
    if (flags.followingAnchor && FOLLOWING.test(t)) {
      // "the following Monday": the one after the request being changed. Without one we can't tell, so ask.
      if (!ctx.anchor) return null;
      return Array.from({ length: 14 }, (_, i) => addDays(ctx.anchor!, i + 1)).find((d) => weekdayOf(d) === target) ?? null;
    }
    const modifier = /\b(next|this|coming)\s+$/.exec(t.slice(0, m.index))?.[1];
    const slotDates = new Set(ctx.openSlots.map((s) => s.date));
    const endOfWeek = addDays(ctx.today, (7 - weekdayOf(ctx.today)) % 7); // coming Sunday
    const candidates = Array.from({ length: 21 }, (_, i) => addDays(ctx.today, i + 1)).filter((d) => weekdayOf(d) === target);
    if (modifier === "next") return candidates.find((d) => d > endOfWeek) ?? null;
    if (modifier === "this") {
      const inWeek = candidates.find((d) => d <= endOfWeek);
      if (inWeek) return inWeek;
    }
    return candidates.slice(0, 2).find((d) => slotDates.has(d)) ?? candidates[0] ?? null;
  }
  return null;
}

const FOLLOWING = /\b(the )?following\b|\bafter that\b|\bthe week after\b/;

const to24 = (h: number, ap: "a" | "p") => (h % 12) + (ap === "p" ? 12 : 0);

function parseTime(t: string): string | null {
  let m = /(?:^|[^\d:/])(\d{1,2})(?::(\d{2}))?\s*(a|p)\.?m\.?(?![a-z])/.exec(t);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${pad(to24(Number(m[1]), m[3] as "a" | "p"))}:${m[2] ?? "00"}`;
  if (/\bnoon\b/.test(t)) return "12:00";
  m = /(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/.exec(t);
  if (m) {
    const h = Number(m[1]);
    return `${pad(h >= 1 && h <= 6 ? h + 12 : h)}:${m[2]}`; // "3:30" in a 9-5 clinic is 3:30 p.m.
  }
  m = /\b(?:at|around|about|@)\s*(\d{1,2})(?:\s*o'?clock)?\b(?!\s*[:/%]|\s*mg)/.exec(t);
  if (m) {
    const h = Number(m[1]);
    if (h >= 1 && h <= 6) return `${pad(h + 12)}:00`; // "at 3" in a 9-5 clinic means 3 p.m.
    if (h >= 7 && h <= 11) return `${pad(h)}:00`;
    if (h === 12) return "12:00";
  }
  return null;
}

export function windowOfTime(hhmm: string): Window {
  const h = Number(hhmm.slice(0, 2));
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

function parseWindow(t: string): Window | null {
  if (/\bafternoons?\b|\bafter lunch\b/.test(t)) return "afternoon";
  if (/\bmornings?\b/.test(t)) return "morning";
  if (/\bevenings?\b|\btonight\b|\bafter work\b/.test(t)) return "evening";
  if (/\b(any ?time|whenever|flexible|no preference|doesn'?t matter|any time of day)\b/.test(t)) return "any";
  return null;
}

const ORDINALS: [RegExp, (n: number) => number][] = [
  [/\b(first|1st|earliest)\b/, () => 0],
  [/\b(second|2nd)\b/, () => 1],
  [/\b(third|3rd)\b/, () => 2],
  [/\b(fourth|4th)\b/, () => 3],
  [/\b(last|latest)\b/, (n) => n - 1],
  [/\boption (\d)\b/, () => -1], // handled below
];

function ordinalSlot(t: string, suggested: OpenSlot[]): OpenSlot | null {
  if (suggested.length === 0) return null;
  const opt = /\boption (\d)\b/.exec(t);
  if (opt) return suggested[Number(opt[1]) - 1] ?? null;
  for (const [re, idx] of ORDINALS.slice(0, 5)) if (re.test(t)) return suggested[idx(suggested.length)] ?? null;
  return null;
}

export function parseSchedule(text: string, ctx: ScheduleContext): Schedule {
  const t = text.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  let date = explicitDate(t, ctx.today) ?? relativeDate(t, ctx.today) ?? weekdayDate(t, ctx) ?? undefined;
  let time = parseTime(t) ?? undefined;
  let window = parseWindow(t) ?? undefined;
  let slot: OpenSlot | undefined = ordinalSlot(t, ctx.suggested) ?? undefined;

  if (!slot && time) {
    const matches = ctx.openSlots.filter((s) => s.start === time && (!date || s.date === date));
    if (matches.length === 1) slot = matches[0];
  }
  if (slot) {
    date = slot.date;
    time = slot.start;
    window = windowOfTime(slot.start);
  } else if (time && !window) {
    window = windowOfTime(time);
  }

  const vague =
    !date && !slot && ((flags.followingAnchor && FOLLOWING.test(t)) || /\b(next|this) week\b|\bnext month\b|\bin (a few |a couple of )?weeks?\b/.test(t) || /\b(soon|asap|as soon as possible)\b/.test(t));

  const out: Schedule = { hasInfo: !!(date || window || time || slot || vague) };
  if (date) {
    out.date = date;
    if (date < ctx.today) out.past = true;
  }
  if (window) out.window = window;
  if (time) out.time = time;
  if (slot) out.slot = slot;
  if (vague) out.vague = true;
  return out;
}
