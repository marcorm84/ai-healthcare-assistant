import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { classifyIntent, parseYesNo } from "../src/agent/intents.js";
import { findReplyViolations, SAFE_FALLBACK_REPLY } from "../src/agent/safety.js";
import { createApp } from "../src/app.js";
import { createContext } from "../src/context.js";

async function setup() {
  const ctx = await createContext({ storeDir: await mkdtemp(path.join(os.tmpdir(), "willow-")) });
  const app = createApp(ctx); // the real rule agent, wrapped by the safety layer
  const say = async (body: string) => (await request(app).post("/api/messages").send({ body })).body;
  const setClock = (now: string) => ctx.clock.set(now);
  return { ctx, app, say, setClock };
}

describe("scenario steps 5, 6, 7, 10 (answers from supplied data)", () => {
  it("step 6: closes at 5:00 p.m. Pacific today (Wednesday)", async () => {
    const { say } = await setup();
    const r = await say("what time do you close today?");
    expect(r.reply.body).toBe("We close at 5:00 p.m. Pacific today (Wednesday).");
    expect(r.patient_message.outcome).toEqual({ kind: "answered" });
  });

  it("step 6 follows the scenario clock: weekend, holiday, after hours", async () => {
    const { say, setClock } = await setup();
    await setClock("2026-11-07T10:00:00-08:00");
    expect((await say("what time do you close today?")).reply.body).toBe(
      "We're closed today (it's a weekend). We reopen on Monday, November 9 at 9:00 a.m. Pacific.",
    );
    await setClock("2026-11-11T10:00:00-08:00");
    expect((await say("are you open today?")).reply.body).toBe(
      "We're closed today (Veterans Day, a federal holiday). We reopen tomorrow, Thursday, at 9:00 a.m. Pacific.",
    );
    await setClock("2026-11-04T18:30:00-08:00");
    expect((await say("what time do you close today?")).reply.body).toBe(
      "We've closed for the day (we close at 5:00 p.m. Pacific). We reopen tomorrow, Thursday, at 9:00 a.m. Pacific.",
    );
  });

  it("step 5: only the booked Jan 14 physical is an appointment", async () => {
    const { say } = await setup();
    expect((await say("when is my next appointment?")).reply.body).toBe(
      "Your next booked appointment is the annual physical with Dr. Priya Lee on Thursday, January 14, 2027 at 9:30 a.m.",
    );
  });

  it("step 5: a pending recheck request is described as a request, kept apart from the appointment", async () => {
    const { ctx, say } = await setup();
    const t = await ctx.repos.threads.getOrCreate("pt_001", "+1-555-010-0199");
    const m = await ctx.repos.messages.append({ thread_id: t.id, sender: "patient", body: "x" });
    await ctx.handoffs.upsert({
      patientId: "pt_001",
      type: "appointment_request",
      details: { reason: "BP recheck", provider: "Dr. Priya Lee", requested_date: "2026-11-12", time_window: "afternoon" },
      sourceMessageId: m.id,
    });
    const reply: string = (await say("when is my next appointment?")).reply.body;
    expect(reply).toBe(
      "Your next booked appointment is the annual physical with Dr. Priya Lee on Thursday, January 14, 2027 at 9:30 a.m. " +
        "Separately, your BP recheck request for Thursday, November 12 (afternoon) is still pending staff review. It isn't a booked appointment.",
    );
  });

  it("step 5: a past booked appointment is not 'next'", async () => {
    const { say, setClock } = await setup();
    await setClock("2027-02-01T10:00:00-08:00");
    expect((await say("when is my next appointment?")).reply.body).toBe("You don't have any booked appointments.");
  });

  it("step 10: explains the $40 from the record and gives the FAQ payment link", async () => {
    const { say } = await setup();
    const reply: string = (await say("why do I owe $40?")).reply.body;
    expect(reply).toBe(
      "Your balance is $40.00. According to your record, it's the copay for Oct 6, 2026 visit. " +
        "You can pay online at https://pay.example.test/willow, or by phone at (555) 010-0100 during business hours.",
    );
  });

  it("step 7: Aetna is unavailable; no guessing, offers to pass it to staff; nothing filed yet", async () => {
    const { ctx, say } = await setup();
    const r = await say("do you take Aetna?");
    expect(r.reply.body).toBe(
      "I don't have information on which insurance plans the clinic accepts. Would you like me to pass your question to staff?",
    );
    expect(r.reply.body).not.toMatch(/yes, we|we do take|we accept/i);
    expect(r.thread.awaiting).toMatchObject({ kind: "pass_to_staff", context: { reason: "insurance_question" } });
    expect(ctx.repos.handoffs.list()).toEqual([]);
  });

  it("step 7 follow-up: 'yes' files an 'other' handoff and says it is pending staff review, with no timeline", async () => {
    const { ctx, say } = await setup();
    await say("do you take Aetna?");
    const r = await say("yes please");
    expect(r.reply.body).toBe(
      "I've passed your question to staff. It's pending staff review. Texts aren't monitored continuously, so I can't say when they'll respond.",
    );
    expect(r.patient_message.outcome).toMatchObject({ kind: "handoff_created" });
    const [h] = ctx.repos.handoffs.list();
    expect(h).toMatchObject({ type: "other", status: "pending_staff", details: { reason: "insurance_question", question: "do you take Aetna?" } });
    expect(h!.source_message_ids).toEqual([r.patient_message.id]);
    expect(r.thread.awaiting).toBeNull();
  });

  it("'no' to the offer files nothing", async () => {
    const { ctx, say } = await setup();
    await say("do you take Aetna?");
    const r = await say("no thanks");
    expect(r.reply.body).toMatch(/won't pass it along/);
    expect(ctx.repos.handoffs.list()).toEqual([]);
  });

  it("asking the same thing twice updates the one record instead of duplicating it", async () => {
    const { ctx, say } = await setup();
    for (let i = 0; i < 2; i++) {
      await say("do you take Aetna?");
      await say("yes");
    }
    expect(ctx.repos.handoffs.list()).toHaveLength(1);
    expect(ctx.repos.handoffs.list()[0]!.source_message_ids).toHaveLength(2);
  });

  it("a different message while the offer is pending is treated as a new message", async () => {
    const { ctx, say } = await setup();
    await say("do you take Aetna?");
    const r = await say("what time do you close today?");
    expect(r.reply.body).toBe("We close at 5:00 p.m. Pacific today (Wednesday).");
    expect(ctx.repos.handoffs.list()).toEqual([]);
    expect(r.thread.awaiting).toBeNull();
  });
});

describe("other FAQ answers use the FAQ's own wording", () => {
  it.each([
    ["what are your hours?", "Our hours: Monday–Friday, 9:00 a.m.–5:00 p.m. Pacific. Closed weekends and federal holidays."],
    ["where are you located?", "Our address: 1200 Example Ave, Suite 300, Springfield, CA 90000. Free parking in the garage behind the building."],
    ["is there parking?", "Our address: 1200 Example Ave, Suite 300, Springfield, CA 90000. Free parking in the garage behind the building."],
    ["what's your phone number?", "You can reach us at (555) 010-0100, during business hours."],
    ["do you read texts right away?", "Texts are read during business hours and are not monitored continuously."],
    ["what should I bring?", "Please bring: photo ID, insurance card, and a list of current medications."],
    ["what's your cancellation policy?", "For cancellations, please give at least 24 hours' notice."],
    ["what insurance do I have?", "The insurance on file for you is Blue Shield of California (PPO)."],
    ["thanks!", "You're welcome, Alex!"],
    ["hello", "Hi Alex! How can I help you today? I can answer questions about the clinic, your appointments, medications and balance, or send a request to staff."],
    ["Hi there!", "Hi Alex! How can I help you today? I can answer questions about the clinic, your appointments, medications and balance, or send a request to staff."],
    ["what can you do?", "I can answer questions about the clinic (hours, address, paying a balance, what to bring), tell you about your appointments, medications and balance, and send requests to staff for appointments, refills and questions. I can't give medical advice."],
  ])("%s", async (question, expected) => {
    const { say } = await setup();
    expect((await say(question)).reply.body).toBe(expected);
  });

  it("a greeting is answered as a greeting: nothing is offered to staff, nothing is filed", async () => {
    const { say, ctx } = await setup();
    const r = await say("hello");
    expect(r.reply.body).not.toMatch(/pass your question to staff/);
    expect(r.thread.awaiting).toBeNull();
    expect(ctx.repos.handoffs.list()).toEqual([]);
  });

  it("a greeting that carries a request is NOT swallowed by the greeting rule", async () => {
    const { say, ctx } = await setup();
    const r = await say("hello, can I get a refill on my BP med");
    expect(r.reply.body).toContain("I've sent a refill request");
    expect(ctx.repos.handoffs.list().map((h) => h.type)).toEqual(["refill"]);
  });

  it("a greeting with an emergency is still an emergency", async () => {
    const { say } = await setup();
    expect((await say("hello I can't breathe")).reply.body).toMatch(/^If you think you are having a medical emergency/);
  });

  it("an unknown question is not guessed at: it offers to pass it to staff", async () => {
    const { say } = await setup();
    const r = await say("do you offer flu shots?");
    expect(r.reply.body).toBe("I don't have information on that. Would you like me to pass your question to staff?");
    expect(r.thread.awaiting).toMatchObject({ kind: "pass_to_staff", context: { reason: "other_question", question: "do you offer flu shots?" } });
  });
});

describe("the agent's own replies never trip the safety guard", () => {
  it("none of the answers above is replaced by the fallback", async () => {
    const { say, ctx } = await setup();
    const questions = [
      "what time do you close today?", "when is my next appointment?", "why do I owe $40?", "do you take Aetna?", "yes",
      "what are your hours?", "where are you?", "what's your phone number?", "do you read texts right away?",
      "what should I bring?", "what's your cancellation policy?", "what insurance do I have?", "do you offer flu shots?", "no",
    ];
    for (const q of questions) {
      const r = await say(q);
      expect(r.reply.body, q).not.toBe(SAFE_FALLBACK_REPLY);
      expect(findReplyViolations(r.reply.body), q).toEqual([]);
    }
    expect(ctx.repos.handoffs.list().every((h) => h.status === "pending_staff")).toBe(true);
  });
});

describe("intent rules", () => {
  it.each([
    ["what time do you close today?", "hours"],
    ["when is my next appointment?", "next_appointment"],
    ["why do I owe $40?", "balance"],
    ["how do I pay my bill", "balance"],
    ["do you take Aetna?", "insurance_acceptance"],
    ["do you accept my insurance", "insurance_acceptance"],
    ["is it booked yet?", "request_status"],
    ["I need my blood pressure rechecked", "appointment_request"],
    ["can I make an appointment?", "appointment_request"],
    ["I want to cancel my appointment", "change_booked_appointment"],
    ["do you have any open slots?", "appointment_request"],
    ["can I get a refill on my BP med", "refill_request"],
    ["my readings have been around 150/95 all week, should I take two pills?", "clinical_question"],
    ["I've been dizzy since yesterday", "clinical_question"],
    ["how many refills do I have left?", "refill_info"],
    ["what pharmacy do you have on file?", "pharmacy_on_file"],
    ["what meds am I on?", "medications_on_file"],
    ["I think this charge is wrong", "billing_request"],
    ["why do I owe $40?", "balance"],
    ["can we do 11/12", "unknown"], // a date, not a reading
    ["Tuesday afternoon works", "unknown"],
    ["hello", "greeting"],
    ["hey!", "greeting"],
    ["good morning", "greeting"],
    ["hello, I need a refill", "refill_request"],
    ["what can you do?", "help"],
  ])("%s -> %s", (text, intent) => expect(classifyIntent(text)).toBe(intent));

  it("parseYesNo only accepts short, plain answers", () => {
    expect(parseYesNo("yes")).toBe("yes");
    expect(parseYesNo("Yes please!")).toBe("yes");
    expect(parseYesNo("no thanks")).toBe("no");
    expect(parseYesNo("yes but can you also move my appointment to next week")).toBeNull();
    expect(parseYesNo("Tuesday afternoon works")).toBeNull();
  });
});
