import { describe, expect, it } from "vitest";
import { parseSchedule } from "../src/agent/dates.js";

const TODAY = "2026-11-04"; // Wednesday
const openSlots = [
  { date: "2026-11-10", start: "14:00", provider: "Dr. Priya Lee" },
  { date: "2026-11-10", start: "15:30", provider: "Dr. Priya Lee" },
  { date: "2026-11-12", start: "13:30", provider: "Dr. Priya Lee" },
  { date: "2026-11-12", start: "16:00", provider: "Dr. Priya Lee" },
];
const parse = (text: string, suggested = openSlots) => parseSchedule(text, { today: TODAY, openSlots, suggested });

describe("weekdays resolve to the date we would actually offer", () => {
  it("Tuesday (said on Wed Nov 4) is Nov 10; Thursday is Nov 12, the Thursday that has openings", () => {
    expect(parse("Tuesday afternoon works")).toMatchObject({ date: "2026-11-10", window: "afternoon" });
    expect(parse("actually can we do Thursday instead")).toMatchObject({ date: "2026-11-12" });
    expect(parse("actually can we do Thursday instead").window).toBeUndefined(); // so the existing window is kept
  });
  it("without openings it is simply the next such weekday", () => {
    expect(parseSchedule("friday", { today: TODAY, openSlots: [], suggested: [] }).date).toBe("2026-11-06");
    expect(parseSchedule("wednesday", { today: TODAY, openSlots: [], suggested: [] }).date).toBe("2026-11-11"); // not today
  });
  it("'next' skips the rest of this week; 'this' stays in it", () => {
    expect(parseSchedule("next friday", { today: TODAY, openSlots: [], suggested: [] }).date).toBe("2026-11-13");
    expect(parseSchedule("this friday", { today: TODAY, openSlots: [], suggested: [] }).date).toBe("2026-11-06");
    expect(parse("next tuesday").date).toBe("2026-11-10");
  });
  it("abbreviations work", () => {
    expect(parse("tues pm").date).toBe("2026-11-10");
    expect(parse("thurs").date).toBe("2026-11-12");
  });
});

describe("explicit and relative dates", () => {
  it.each([
    ["Nov 12", "2026-11-12"],
    ["November 10th please", "2026-11-10"],
    ["the 12th of november", "2026-11-12"],
    ["11/12", "2026-11-12"],
    ["11/12/2026", "2026-11-12"],
    ["2026-11-12", "2026-11-12"],
    ["the 10th", "2026-11-10"],
    ["tomorrow", "2026-11-05"],
    ["day after tomorrow", "2026-11-06"],
    ["January 14", "2027-01-14"],
  ])("%s -> %s", (text, date) => expect(parse(text).date).toBe(date));

  it("flags dates that already passed, and rejects impossible ones", () => {
    expect(parse("Nov 3")).toMatchObject({ date: "2026-11-03", past: true });
    expect(parse("Nov 31").date).toBeUndefined();
    expect(parse("2/30").date).toBeUndefined();
  });
  it("does not mistake blood pressure readings or doses for dates or times", () => {
    expect(parse("my readings have been around 150/95 all week").hasInfo).toBe(false);
    expect(parse("take 10 mg once daily").hasInfo).toBe(false);
  });
});

describe("time of day", () => {
  it.each([
    ["afternoon", "afternoon"], ["in the morning", "morning"], ["evening", "evening"], ["any time", "any"], ["whenever", "any"],
    ["2pm", "afternoon"], ["9:30 am", "morning"], ["at 3", "afternoon"], ["noon", "afternoon"],
  ])("%s -> window %s", (text, window) => expect(parse(text).window).toBe(window));

  it("a time that matches exactly one open slot selects it", () => {
    expect(parse("Tuesday at 2pm").slot).toEqual(openSlots[0]);
    expect(parse("Thursday 4:00 p.m.").slot).toEqual(openSlots[3]);
    expect(parse("3:30").slot).toEqual(openSlots[1]);
  });
  it("a time with no matching slot is kept as a preference, with no slot", () => {
    const s = parse("Tuesday at 3pm");
    expect(s).toMatchObject({ date: "2026-11-10", time: "15:00", window: "afternoon" });
    expect(s.slot).toBeUndefined();
  });
  it("'the second one' refers to the slots we listed, in order", () => {
    expect(parse("the second one").slot).toEqual(openSlots[1]);
    expect(parse("the last one").slot).toEqual(openSlots[3]);
    expect(parse("option 3").slot).toEqual(openSlots[2]);
    expect(parse("the second one", []).hasInfo).toBe(false);
  });
});

describe("vague and non-scheduling messages", () => {
  it.each(["next week", "soon", "asap", "sometime next month"])("%s needs a specific day", (text) => {
    expect(parse(text)).toMatchObject({ vague: true, hasInfo: true });
    expect(parse(text).date).toBeUndefined();
  });
  it.each(["yes", "do you take Aetna?", "why do I owe $40?", "can I get a refill on my BP med"])("%s has no schedule", (text) => {
    expect(parse(text).hasInfo).toBe(false);
  });
});

describe('"the following Monday" is relative to the request being changed', () => {
  it("with a request on Tue Nov 10 it means Mon Nov 16", () => {
    expect(parseSchedule("how about the following Monday?", { today: TODAY, openSlots, suggested: openSlots, anchor: "2026-11-10" }).date).toBe("2026-11-16");
    expect(parseSchedule("the following Friday", { today: TODAY, openSlots, suggested: openSlots, anchor: "2026-11-10" }).date).toBe("2026-11-13");
  });
  it("with nothing to be relative to it does not guess: it needs a day", () => {
    const s = parseSchedule("how about the following Monday?", { today: TODAY, openSlots, suggested: openSlots });
    expect(s.date).toBeUndefined();
    expect(s.vague).toBe(true);
  });
});
