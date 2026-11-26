import { describe, expect, it } from "vitest";
import { federalHoliday, parseHours, statusAt } from "../src/agent/hours.js";
import { parseFaq } from "../src/agent/knowledge.js";
import { formatTime, longDate } from "../src/format.js";
import { clinicParts } from "../src/time.js";

const FAQ_HOURS = "Monday–Friday, 9:00 a.m.–5:00 p.m. Pacific. Closed weekends and federal holidays.";
const hours = parseHours(FAQ_HOURS);
const at = (iso: string) => statusAt(hours, iso);

describe("FAQ parsing", () => {
  it("reads the hours from the FAQ text", () => {
    expect(hours).toEqual({ days: [1, 2, 3, 4, 5], open: "09:00", close: "17:00", zone: "Pacific", closedOnFederalHolidays: true });
  });
  it("fails loudly if the FAQ hours can't be understood", () => {
    expect(() => parseHours("Whenever we feel like it")).toThrow(/Could not parse/);
    expect(() => parseFaq("- Address: somewhere")).toThrow(/no 'Hours' entry/);
  });
  it("extracts the payment URL without trailing punctuation", () => {
    const k = parseFaq(`- Hours: ${FAQ_HOURS}\n- Paying a balance: online at https://pay.example.test/willow, or by phone.`);
    expect(k.payUrl).toBe("https://pay.example.test/willow");
    expect(k.get("Paying a balance")).toContain("or by phone");
    expect(k.get("insurance")).toBeUndefined();
  });
});

describe("clinic-local time", () => {
  it("converts to Pacific, including the date change and DST", () => {
    expect(clinicParts("2026-11-04T10:00:00-08:00")).toEqual({ date: "2026-11-04", weekday: 3, minutes: 600 });
    expect(clinicParts("2026-11-05T00:30:00Z")).toEqual({ date: "2026-11-04", weekday: 3, minutes: 990 }); // 4:30 p.m. PST
    expect(clinicParts("2026-07-01T16:00:00Z")).toMatchObject({ date: "2026-07-01", minutes: 540 }); // 9:00 a.m. PDT
  });
  it("formats dates and times", () => {
    expect(formatTime("09:30")).toBe("9:30 a.m.");
    expect(formatTime("17:00")).toBe("5:00 p.m.");
    expect(formatTime("12:00")).toBe("12:00 p.m.");
    expect(longDate("2026-11-10", "2026-11-04")).toBe("Tuesday, November 10");
    expect(longDate("2027-01-14", "2026-11-04")).toBe("Thursday, January 14, 2027");
  });
});

describe("federal holidays", () => {
  it.each([
    ["2026-11-11", "Veterans Day"],
    ["2026-11-26", "Thanksgiving"],
    ["2026-12-25", "Christmas Day"],
    ["2026-07-03", "Independence Day"], // Jul 4 is a Saturday -> observed Friday
    ["2026-09-07", "Labor Day"],
    ["2027-01-01", "New Year's Day"],
    ["2027-01-18", "Martin Luther King Jr. Day"],
    ["2027-05-31", "Memorial Day"],
  ])("%s is %s", (date, name) => expect(federalHoliday(date)).toBe(name));
  it("ordinary days are not holidays", () => {
    expect(federalHoliday("2026-11-04")).toBeNull();
    expect(federalHoliday("2026-07-04")).toBeNull(); // the Saturday itself isn't the observed day
  });
});

describe("open / closed", () => {
  it("Wednesday 10:00 is open and closes at 17:00 (scenario step 6)", () => {
    expect(at("2026-11-04T10:00:00-08:00")).toEqual({ kind: "open", date: "2026-11-04", closes: "17:00" });
  });
  it("before opening and after closing", () => {
    expect(at("2026-11-04T08:59:00-08:00").kind).toBe("before_open");
    expect(at("2026-11-04T16:59:00-08:00").kind).toBe("open");
    expect(at("2026-11-04T17:00:00-08:00")).toMatchObject({ kind: "after_close", next: { date: "2026-11-05" } });
  });
  it("weekends reopen on Monday", () => {
    expect(at("2026-11-07T10:00:00-08:00")).toMatchObject({ kind: "closed_day", reason: "it's a weekend", next: { date: "2026-11-09" } });
    expect(at("2026-11-06T18:00:00-08:00")).toMatchObject({ kind: "after_close", next: { date: "2026-11-09" } }); // Friday evening
  });
  it("federal holidays are closed days", () => {
    expect(at("2026-11-11T10:00:00-08:00")).toMatchObject({ kind: "closed_day", reason: "Veterans Day, a federal holiday", next: { date: "2026-11-12" } });
    expect(at("2026-11-26T10:00:00-08:00")).toMatchObject({ kind: "closed_day", next: { date: "2026-11-27" } });
  });
});
