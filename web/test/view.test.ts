import { describe, expect, it } from "vitest";
import type { Handoff, Message } from "../src/types";
import { answeredQuestions, detailRows, formatClock, formatDay, formatLocalInput, formatTime12, formatUsDateTime, parseUsDateTime, groupHandoffs, nextStep, outcomeTag, toLocalInput } from "../src/view";

const msg = (id: string, sender: Message["sender"], body: string, extra: Partial<Message> = {}): Message => ({
  id, thread_id: "t", sender, body, in_reply_to: null, created_at: "2026-11-04T10:00:00-08:00", ...extra,
});
const handoff = (id: string, status: Handoff["status"], type: Handoff["type"] = "refill", details: Handoff["details"] = {}): Handoff => ({
  id, patient_id: "pt_001", type, status, details, source_message_ids: [], created_at: "", updated_at: "", summary: id,
});

describe("outcomeTag: what the patient/staff see under each assistant reply", () => {
  const messages = [
    msg("p1", "patient", "when do you close?", { outcome: { kind: "answered" } }),
    msg("a1", "agent", "5pm", { in_reply_to: "p1" }),
    msg("p2", "patient", "refill", { outcome: { kind: "handoff_created", handoff_id: "ho_1" } }),
    msg("a2", "agent", "sent", { in_reply_to: "p2" }),
    msg("p3", "patient", "chest pain", { outcome: { kind: "emergency", handoff_id: "ho_2" } }),
    msg("a3", "agent", "call 911", { in_reply_to: "p3" }),
    msg("p4", "patient", "i need an appointment", { outcome: { kind: "clarifying" } }),
    msg("a4", "agent", "when?", { in_reply_to: "p4" }),
    msg("p5", "patient", "Thursday", { outcome: { kind: "handoff_updated", handoff_id: "ho_3" } }),
    msg("a5", "agent", "updated", { in_reply_to: "p5" }),
    msg("p6", "patient", "no outcome yet"),
    msg("a6", "agent", "?", { in_reply_to: "p6" }),
  ];
  const tag = (id: string) => outcomeTag(messages.find((m) => m.id === id)!, messages);

  it("answered directly", () => expect(tag("a1")).toEqual({ label: "Answered by assistant", tone: "ok" }));
  it("sent to staff, linked to the handoff", () => expect(tag("a2")).toEqual({ label: "Sent to staff · pending review", tone: "pending", handoffId: "ho_1" }));
  it("emergency", () => expect(tag("a3")).toMatchObject({ tone: "danger", handoffId: "ho_2" }));
  it("emergency whose handoff could not be saved does NOT say it was logged", () => {
    const ms = [msg("p", "patient", "chest pain", { outcome: { kind: "emergency" } }), msg("a", "agent", "call 911", { in_reply_to: "p" })];
    const t = outcomeTag(ms[1]!, ms)!;
    expect(t.label).toBe("Emergency text sent · NOT logged for staff");
    expect(t.label).not.toMatch(/^Emergency logged/);
    expect(t.handoffId).toBeUndefined();
  });
  it("a reply where the AI model classified the message says so", () => {
    const ms = [msg("p", "patient", "top up my tablets", { outcome: { kind: "handoff_created", handoff_id: "ho_9", via: "llm" } }), msg("a", "agent", "sent", { in_reply_to: "p" })];
    expect(outcomeTag(ms[1]!, ms)).toEqual({ label: "Sent to staff · pending review · AI-assisted", tone: "pending", handoffId: "ho_9" });
    const plain = [msg("p", "patient", "refill", { outcome: { kind: "handoff_created", handoff_id: "ho_9" } }), msg("a", "agent", "sent", { in_reply_to: "p" })];
    expect(outcomeTag(plain[1]!, plain)!.label).toBe("Sent to staff · pending review"); // rules path unchanged
  });
  it("follow-up question", () => expect(tag("a4")).toEqual({ label: "Asked a follow-up", tone: "info" }));
  it("updated request", () => expect(tag("a5")).toMatchObject({ label: "Staff request updated", handoffId: "ho_3" }));
  it("no tag without an outcome, and none for patient or clinic messages", () => {
    expect(tag("a6")).toBeNull();
    expect(tag("p1")).toBeNull();
    expect(outcomeTag(msg("c", "clinic", "hi"), messages)).toBeNull();
  });
});

describe("groupHandoffs / answeredQuestions", () => {
  it("separates requests awaiting staff from those staff already processed, newest first", () => {
    const hs = [handoff("a", "pending_staff"), handoff("b", "completed"), handoff("c", "pending_staff"), handoff("d", "rejected")];
    const g = groupHandoffs(hs);
    expect(g.awaiting.map((h) => h.id)).toEqual(["c", "a"]);
    expect(g.processed.map((h) => h.id)).toEqual(["d", "b"]);
  });

  it("lists the questions the assistant answered, with the answer", () => {
    const messages = [
      msg("p1", "patient", "why do I owe $40?", { outcome: { kind: "answered" } }),
      msg("a1", "agent", "copay", { in_reply_to: "p1" }),
      msg("p2", "patient", "refill", { outcome: { kind: "handoff_created", handoff_id: "h" } }),
      msg("a2", "agent", "sent", { in_reply_to: "p2" }),
    ];
    expect(answeredQuestions(messages)).toEqual([{ id: "p1", question: "why do I owe $40?", answer: "copay" }]);
  });
});

describe("detailRows", () => {
  it("shows filled fields with readable labels and skips empty ones", () => {
    const h = handoff("x", "pending_staff", "appointment_request", {
      reason: "BP recheck", provider: "Dr. Priya Lee", requested_date: "2026-11-12", time_window: "afternoon", requested_slot: null, patient_note: null,
    });
    expect(detailRows(h)).toEqual([["Reason", "BP recheck"], ["Provider", "Dr. Priya Lee"], ["Date", "Thu, Nov 12, 2026"], ["Window", "afternoon"]]);
  });
  it("formats slots, money, counts and lists", () => {
    expect(detailRows(handoff("x", "pending_staff", "appointment_request", { requested_slot: { date: "2026-11-10", start: "14:00" } }))).toEqual([["Slot", "Tue, Nov 10, 2026 · 2:00 PM"]]);
    expect(detailRows(handoff("x", "pending_staff", "billing", { balance_amount: 40 }))).toEqual([["Balance", "$40.00"]]);
    expect(detailRows(handoff("x", "pending_staff", "refill", { refills_remaining: 0 }))).toEqual([["Refills left", "0"]]);
    expect(detailRows(handoff("x", "pending_staff", "emergency", { signals: ["chest_pain", "arm_jaw_numb"] }))).toEqual([["Signals", "chest_pain · arm_jaw_numb"]]);
  });
});

describe("clock formatting uses the clinic's time zone, not the browser's", () => {
  it("formatClock", () => {
    expect(formatClock("2026-11-04T10:00:00-08:00")).toBe("Wed, Nov 4, 2026 · 10:00 AM PT");
    expect(formatClock("2026-11-04T18:00:00Z")).toBe("Wed, Nov 4, 2026 · 10:00 AM PT");
  });
  it("toLocalInput round-trips the wall-clock time", () => {
    expect(toLocalInput("2026-11-04T10:00:00-08:00")).toBe("2026-11-04T10:00");
    expect(toLocalInput("2026-07-01T10:00:00-07:00")).toBe("2026-07-01T10:00");
  });
});

describe("nextStep", () => {
  const steps = [{ n: 0, input: "hello" }, { n: 1, input: "yes" }, { n: 2, input: "bye" }];
  it("is the first step not yet in the thread", () => {
    expect(nextStep(steps, [])?.n).toBe(0);
    expect(nextStep(steps, [msg("1", "clinic", "hello")])?.n).toBe(1);
    expect(nextStep(steps, [msg("1", "clinic", "hello"), msg("2", "patient", "yes"), msg("3", "patient", "bye")])).toBeUndefined();
  });
});

describe("one date/time format everywhere, in the clinic's Pacific time", () => {
  it("formatDay / formatTime12", () => {
    expect(formatDay("2026-11-12")).toBe("Thu, Nov 12, 2026");
    expect(formatDay("2027-01-14")).toBe("Thu, Jan 14, 2027");
    expect(formatDay("not-a-date")).toBe("not-a-date");
    expect(formatTime12("14:00")).toBe("2:00 PM");
    expect(formatTime12("09:30")).toBe("9:30 AM");
    expect(formatTime12("12:00")).toBe("12:00 PM");
    expect(formatTime12("00:15")).toBe("12:15 AM");
  });
  it("the picker preview reads exactly like the clock, whatever the browser's locale", () => {
    expect(formatLocalInput("2026-11-07T10:00")).toBe("Sat, Nov 7, 2026 · 10:00 AM PT");
    expect(formatLocalInput("2026-11-07T10:00")).toBe(formatClock("2026-11-07T10:00:00-08:00"));
    expect(formatLocalInput("2026-11-04T18:00")).toBe(formatClock("2026-11-04T18:00:00-08:00"));
    expect(formatLocalInput("")).toBe("");
  });
});

describe("US date entry for the demo clock (MM/DD/YYYY, month first)", () => {
  it("formats the clock value month-first", () => {
    expect(formatUsDateTime("2026-11-04T10:00")).toBe("11/04/2026 10:00 AM");
    expect(formatUsDateTime("2026-11-07T18:30")).toBe("11/07/2026 6:30 PM");
    expect(formatUsDateTime("")).toBe("");
  });
  it.each([
    ["11/07/2026 10:00 AM", "2026-11-07T10:00"],
    ["11/7/2026 9:05 pm", "2026-11-07T21:05"],
    ["11/04/2026 12:00 AM", "2026-11-04T00:00"],
    ["11/04/2026 12:30 PM", "2026-11-04T12:30"],
    ["11/11/2026 14:30", "2026-11-11T14:30"],
    ["  11/07/2026   10:00am ", "2026-11-07T10:00"],
  ])("parses %s", (text, local) => expect(parseUsDateTime(text)).toBe(local));
  it.each(["", "04/11/2026", "13/01/2026 10:00 AM", "02/30/2026 10:00 AM", "11/07/2026 13:00 PM", "11/07/2026 0:30 AM", "11/07/2026 25:00", "11/07/2026 10:60 AM", "Nov 7 2026 10am", "2026-11-07T10:00"])("rejects %j", (text) => {
    expect(parseUsDateTime(text)).toBeNull();
  });
  it("round-trips with the clock value", () => {
    for (const v of ["2026-11-04T10:00", "2026-11-07T00:15", "2026-11-11T23:59", "2027-01-14T09:30"]) expect(parseUsDateTime(formatUsDateTime(v))).toBe(v);
  });
});
