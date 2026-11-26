import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createContext } from "../src/context.js";
import { HandoffError } from "../src/handoffs/service.js";

const PID = "pt_001";

async function setup() {
  const ctx = await createContext({ storeDir: await mkdtemp(path.join(os.tmpdir(), "willow-")) });
  const thread = await ctx.repos.threads.getOrCreate(PID, "+1-555-010-0199");
  const msg = async (body = "hi") => (await ctx.repos.messages.append({ thread_id: thread.id, sender: "patient", body })).id;
  return { ctx, msg, svc: ctx.handoffs };
}

const appt = (over: Record<string, unknown> = {}) => ({
  reason: "BP recheck",
  provider: "Dr. Priya Lee",
  requested_date: "2026-11-10",
  time_window: "afternoon",
  ...over,
});

const refill = (over: Record<string, unknown> = {}) => ({
  medication: "Lisinopril",
  dose: "10 mg",
  frequency: "once daily",
  pharmacy: "Elm Street Pharmacy, (555) 010-0142",
  refills_remaining: 0,
  ...over,
});

const issues = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(HandoffError);
  return err as HandoffError;
};

describe("handoff creation and validation", () => {
  it("creates a pending_staff record with defaults filled and its source message", async () => {
    const { svc, msg } = await setup();
    const m = await msg();
    const { handoff, action } = await svc.upsert({ patientId: PID, type: "appointment_request", details: appt(), sourceMessageId: m });
    expect(action).toBe("created");
    expect(handoff).toMatchObject({ patient_id: PID, type: "appointment_request", status: "pending_staff", source_message_ids: [m] });
    expect(handoff.details).toEqual({ ...appt(), requested_slot: null, patient_note: null });
    expect(svc.summarize(handoff)).toBe("BP recheck · Dr. Priya Lee · 2026-11-10 afternoon");
  });

  it("accepts a slot Alex picked only if it really is open and matches the date", async () => {
    const { svc, msg } = await setup();
    const m = await msg();
    const slot = { date: "2026-11-10", start: "14:00", provider: "Dr. Priya Lee" };
    const ok = await svc.upsert({ patientId: PID, type: "appointment_request", details: appt({ requested_slot: slot }), sourceMessageId: m });
    expect(svc.summarize(ok.handoff)).toContain("@ 14:00");

    const { svc: s2, msg: m2 } = await setup();
    const id = await m2();
    expect((await issues(s2.upsert({ patientId: PID, type: "appointment_request", details: appt({ requested_slot: { ...slot, start: "10:00" } }), sourceMessageId: id }))).issues[0]).toMatch(/not an open slot/);
    expect((await issues(s2.upsert({ patientId: PID, type: "appointment_request", details: appt({ requested_slot: { date: "2026-11-12", start: "13:30", provider: "Dr. Priya Lee" } }), sourceMessageId: id }))).issues[0]).toMatch(/does not match requested_date/);
  });

  it.each([
    ["missing reason", appt({ reason: undefined }), /reason/],
    ["empty reason", appt({ reason: "  " }), /reason/],
    ["bad date format", appt({ requested_date: "11/10/2026" }), /YYYY-MM-DD/],
    ["impossible date", appt({ requested_date: "2026-02-31" }), /real calendar date/],
    ["date in the past (clock is Nov 4)", appt({ requested_date: "2026-11-03" }), /in the past/],
    ["unknown window", appt({ time_window: "midnight" }), /time_window/],
    ["unknown field", appt({ status: "booked" }), /Unrecognized key/],
  ])("rejects an appointment request with %s", async (_name, details, pattern) => {
    const { svc, ctx, msg } = await setup();
    const err = await issues(svc.upsert({ patientId: PID, type: "appointment_request", details, sourceMessageId: await msg() }));
    expect(err.code).toBe("invalid_details");
    expect(err.message).toMatch(pattern);
    expect(ctx.repos.handoffs.list()).toHaveLength(0); // nothing saved on failure
  });

  it("only accepts a refill that matches the record (no invented medications or doses)", async () => {
    const { svc, msg } = await setup();
    const m = await msg();
    const ok = await svc.upsert({ patientId: PID, type: "refill", details: refill(), sourceMessageId: m });
    expect(svc.summarize(ok.handoff)).toBe("Lisinopril 10 mg, once daily · Elm Street Pharmacy, (555) 010-0142 · refills left: 0");

    const { svc: s2, msg: m2 } = await setup();
    const id = await m2();
    expect((await issues(s2.upsert({ patientId: PID, type: "refill", details: refill({ medication: "Metformin" }), sourceMessageId: id }))).message).toMatch(/not on the patient's medication list/);
    expect((await issues(s2.upsert({ patientId: PID, type: "refill", details: refill({ dose: "20 mg" }), sourceMessageId: id }))).message).toMatch(/does not match the record/);
  });

  it("requires the question for a clinical_question and keeps the readings", async () => {
    const { svc, msg } = await setup();
    const m = await msg();
    await issues(svc.upsert({ patientId: PID, type: "clinical_question", details: { reported_readings: "150/95" }, sourceMessageId: m }));
    const { handoff } = await svc.upsert({
      patientId: PID,
      type: "clinical_question",
      details: { question: "should I take two pills?", reported_readings: "around 150/95 all week", related_medication: "Lisinopril" },
      sourceMessageId: m,
    });
    expect(handoff.details).toMatchObject({ reported_readings: "around 150/95 all week", duration: null });
  });

  it("supports identity-related reasons on type: other", async () => {
    const { svc, msg } = await setup();
    const { handoff } = await svc.upsert({ patientId: PID, type: "other", details: { reason: "third_party_contact" }, sourceMessageId: await msg() });
    expect(handoff.details).toMatchObject({ reason: "third_party_contact" });
  });
});

describe("one request, not duplicates", () => {
  it("a second appointment request updates the open one", async () => {
    const { svc, ctx, msg } = await setup();
    const [m1, m2] = [await msg(), await msg()];
    const a = await svc.upsert({ patientId: PID, type: "appointment_request", details: appt(), sourceMessageId: m1 });
    const b = await svc.upsert({ patientId: PID, type: "appointment_request", details: appt({ requested_date: "2026-11-12" }), sourceMessageId: m2 });
    expect(b.action).toBe("updated");
    expect(b.handoff.id).toBe(a.handoff.id);
    expect(ctx.repos.handoffs.list()).toHaveLength(1);
    expect(b.handoff.source_message_ids).toEqual([m1, m2]);
  });

  it("dedupes a repeated refill for the same medication but not different types", async () => {
    const { svc, ctx, msg } = await setup();
    const [m1, m2, m3] = [await msg(), await msg(), await msg()];
    await svc.upsert({ patientId: PID, type: "refill", details: refill(), sourceMessageId: m1 });
    const again = await svc.upsert({ patientId: PID, type: "refill", details: refill({ medication: "lisinopril " }), sourceMessageId: m2 });
    expect(again.action).toBe("updated");
    await svc.upsert({ patientId: PID, type: "appointment_request", details: appt(), sourceMessageId: m3 });
    expect(ctx.repos.handoffs.list().map((h) => h.type)).toEqual(["refill", "appointment_request"]);
  });

  it("a request staff already closed is never reopened: a new one is created", async () => {
    const { svc, ctx, msg } = await setup();
    const a = await svc.upsert({ patientId: PID, type: "appointment_request", details: appt(), sourceMessageId: await msg() });
    await ctx.repos.handoffs.update(a.handoff.id, { status: "completed" });
    const b = await svc.upsert({ patientId: PID, type: "appointment_request", details: appt(), sourceMessageId: await msg() });
    expect(b.action).toBe("created");
    expect(b.handoff.id).not.toBe(a.handoff.id);
  });

  it("different questions stay separate records", async () => {
    const { svc, ctx, msg } = await setup();
    const m = await msg();
    await svc.upsert({ patientId: PID, type: "other", details: { reason: "insurance_question", question: "Do you take Aetna?" }, sourceMessageId: m });
    await svc.upsert({ patientId: PID, type: "other", details: { reason: "insurance_question", question: "Do you take Cigna?" }, sourceMessageId: m });
    expect(ctx.repos.handoffs.list()).toHaveLength(2);
  });
});

describe("updating a request (scenario step 3)", () => {
  it("changes the date and keeps the afternoon window, still one pending record", async () => {
    const { svc, ctx, msg } = await setup();
    const [m1, m2] = [await msg(), await msg()];
    const { handoff } = await svc.upsert({ patientId: PID, type: "appointment_request", details: appt(), sourceMessageId: m1 });
    const r = await svc.update(handoff.id, { requested_date: "2026-11-12" }, m2);
    expect(r.action).toBe("updated");
    expect(r.handoff).toMatchObject({ status: "pending_staff", source_message_ids: [m1, m2] });
    expect(r.handoff.details).toMatchObject({ requested_date: "2026-11-12", time_window: "afternoon", reason: "BP recheck" });
    expect(ctx.repos.handoffs.list()).toHaveLength(1);
  });

  it("is idempotent: replaying the same change is 'unchanged'", async () => {
    const { svc, msg } = await setup();
    const [m1, m2] = [await msg(), await msg()];
    const { handoff } = await svc.upsert({ patientId: PID, type: "appointment_request", details: appt(), sourceMessageId: m1 });
    await svc.update(handoff.id, { requested_date: "2026-11-12" }, m2);
    const again = await svc.update(handoff.id, { requested_date: "2026-11-12" }, m2);
    expect(again.action).toBe("unchanged");
    expect(again.handoff.source_message_ids).toEqual([m1, m2]);
  });

  it("an invalid change is rejected and the stored record is untouched", async () => {
    const { svc, ctx, msg } = await setup();
    const m = await msg();
    const { handoff } = await svc.upsert({ patientId: PID, type: "appointment_request", details: appt(), sourceMessageId: m });
    const err = await issues(svc.update(handoff.id, { requested_date: "2026-11-01" }, await msg()));
    expect(err.code).toBe("invalid_details");
    expect(ctx.repos.handoffs.get(handoff.id)).toEqual(handoff);
  });

  it("refuses to change a request staff already acted on, or one that does not exist", async () => {
    const { svc, ctx, msg } = await setup();
    const m = await msg();
    const { handoff } = await svc.upsert({ patientId: PID, type: "appointment_request", details: appt(), sourceMessageId: m });
    await ctx.repos.handoffs.update(handoff.id, { status: "approved" });
    expect((await issues(svc.update(handoff.id, { requested_date: "2026-11-12" }, m))).code).toBe("not_open");
    expect((await issues(svc.update("ho_nope", {}, m))).code).toBe("not_found");
  });

  it("findOpen returns only the patient's open requests of that type", async () => {
    const { svc, ctx, msg } = await setup();
    const m = await msg();
    const a = await svc.upsert({ patientId: PID, type: "appointment_request", details: appt(), sourceMessageId: m });
    await svc.upsert({ patientId: PID, type: "refill", details: refill(), sourceMessageId: m });
    expect(svc.findOpen(PID, "appointment_request").map((h) => h.id)).toEqual([a.handoff.id]);
    await ctx.repos.handoffs.update(a.handoff.id, { status: "completed" });
    expect(svc.findOpen(PID, "appointment_request")).toEqual([]);
  });
});

describe("emergency records through the same service", () => {
  it("merges signals and messages instead of overwriting them", async () => {
    const { svc, msg } = await setup();
    const [m1, m2] = [await msg(), await msg()];
    await svc.upsert({ patientId: PID, type: "emergency", details: { signals: ["chest_pain"], patient_messages: ["my chest hurts"] }, sourceMessageId: m1 });
    const r = await svc.upsert({ patientId: PID, type: "emergency", details: { signals: ["arm_jaw_numb", "chest_pain"], patient_messages: ["arm numb"] }, sourceMessageId: m2 });
    expect(r.action).toBe("updated");
    expect(r.handoff.details).toEqual({ signals: ["chest_pain", "arm_jaw_numb"], patient_messages: ["my chest hurts", "arm numb"], channel: "text" });
  });
});

describe("thread view", () => {
  it("includes a staff-readable summary per handoff", async () => {
    const { ctx, svc, msg } = await setup();
    await svc.upsert({ patientId: PID, type: "refill", details: refill(), sourceMessageId: await msg() });
    const view = (await request(createApp(ctx)).get("/api/thread")).body;
    expect(view.handoffs[0]).toMatchObject({ type: "refill", status: "pending_staff" });
    expect(view.handoffs[0].summary).toContain("Lisinopril 10 mg");
  });
});
