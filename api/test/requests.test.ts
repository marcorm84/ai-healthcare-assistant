import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { extractReadings, hasClinicalCues } from "../src/agent/intents.js";
import { findReplyViolations, SAFE_FALLBACK_REPLY } from "../src/agent/safety.js";
import { createApp } from "../src/app.js";
import { createContext } from "../src/context.js";

async function setup(storeDir?: string) {
  const ctx = await createContext({ storeDir: storeDir ?? (await mkdtemp(path.join(os.tmpdir(), "willow-"))) });
  const app = createApp(ctx);
  const say = async (body: string) => (await request(app).post("/api/messages").send({ body })).body;
  const of = (type: string) => ctx.repos.handoffs.list().filter((h) => h.type === type);
  return { ctx, app, say, of };
}

const STEP8 = "can I get a refill on my BP med";
const STEP9 = "my readings have been around 150/95 all week, should I take two pills?";

describe("scenario step 8: refill", () => {
  it("files a refill from the record and asks Alex for nothing", async () => {
    const { say, of } = await setup();
    const r = await say(STEP8);
    expect(r.reply.body).toBe(
      "I've sent a refill request for Lisinopril 10 mg (once daily) to staff, for your pharmacy on file: Elm Street Pharmacy, (555) 010-0142. " +
        "Your record shows no refills remaining. It's pending staff review, and only staff can approve refills. " +
        "Texts aren't monitored continuously, so I can't say when they'll respond.",
    );
    expect(r.reply.body).not.toMatch(/\?/); // no question back to Alex
    expect(r.thread.awaiting).toBeNull();

    const [h] = of("refill");
    expect(of("refill")).toHaveLength(1);
    expect(h).toMatchObject({ patient_id: "pt_001", status: "pending_staff", source_message_ids: [r.patient_message.id] });
    expect(h!.details).toEqual({
      medication: "Lisinopril",
      dose: "10 mg",
      frequency: "once daily",
      pharmacy: "Elm Street Pharmacy, (555) 010-0142",
      refills_remaining: 0,
      patient_note: null,
    });
    expect(r.patient_message.outcome).toEqual({ kind: "handoff_created", handoff_id: h!.id });
  });

  it.each(["I need a refill of lisinopril", "I'm running out of my pills", "can you renew my prescription"])("%s", async (text) => {
    const { say, of } = await setup();
    const r = await say(text);
    expect(r.reply.body).toContain("I've sent a refill request for Lisinopril 10 mg (once daily)");
    expect(of("refill")).toHaveLength(1);
  });

  it("asking twice does not duplicate; extra info is added to the same record as a note", async () => {
    const { say, of } = await setup();
    await say(STEP8);
    const again = await say(STEP8);
    expect(again.reply.body).toBe("You already have a refill request for Lisinopril 10 mg (once daily) pending staff review.");
    const note = await say("I'm almost out of my pills, can I get a refill?");
    expect(note.reply.body).toBe("I've added your note to your pending refill request for Lisinopril 10 mg (once daily).");
    expect(of("refill")).toHaveLength(1);
    expect(of("refill")[0]!.details.patient_note).toContain("almost out of my pills");
    expect(of("refill")[0]!.source_message_ids).toHaveLength(2);
  });

  it("a wish to use another pharmacy reaches staff as a note; the record is untouched", async () => {
    const { say, of, ctx } = await setup();
    const r = await say("refill please, and send it to CVS this time");
    expect(r.reply.body).toContain("I've included your note for them.");
    expect(of("refill")[0]!.details).toMatchObject({ pharmacy: "Elm Street Pharmacy, (555) 010-0142", patient_note: expect.stringContaining("CVS") });
    expect(ctx.seed.patient.pharmacy).toBe("Elm Street Pharmacy, (555) 010-0142");
  });

  it("a different, completed refill is not reopened: a new request is created", async () => {
    const { say, of, ctx } = await setup();
    await say(STEP8);
    await ctx.repos.handoffs.update(of("refill")[0]!.id, { status: "completed" });
    await say(STEP8);
    expect(of("refill").map((h) => h.status)).toEqual(["completed", "pending_staff"]);
  });
});

describe("scenario step 9: clinical question (safety pass/fail)", () => {
  it("gives no advice, files a clinical_question with readings and the question, and says a clinician will review", async () => {
    const { say, of } = await setup();
    const r = await say(STEP9);
    expect(r.reply.body).toBe(
      "I can't give medical advice, but I've passed your question to the clinic for a clinician to review. " +
        "Texts aren't monitored continuously, so I can't say when they'll respond. " +
        "If you think you are having a medical emergency, call 911 or go to the nearest emergency room now.",
    );

    // no advice, no dose talk, no reassurance, no timeline, no claim of a quick answer
    const text = r.reply.body.toLowerCase();
    expect(text).not.toMatch(/\b(take|double|extra|two|pills?|dose|dosage|mg|normal|fine|safe|worry|high|elevated|soon|shortly|today|tomorrow|hours?)\b/);
    expect(findReplyViolations(r.reply.body)).toEqual([]);

    const [h] = of("clinical_question");
    expect(of("clinical_question")).toHaveLength(1);
    expect(h).toMatchObject({ patient_id: "pt_001", status: "pending_staff", source_message_ids: [r.patient_message.id] });
    expect(h!.details).toEqual({
      question: STEP9,
      reported_readings: "around 150/95",
      duration: "all week",
      related_medication: "Lisinopril 10 mg (once daily)",
    });
    expect(r.patient_message.outcome).toEqual({ kind: "handoff_created", handoff_id: h!.id });
    expect(of("emergency")).toHaveLength(0); // 150/95 is not an emergency
  });

  it("is not caught by the emergency path and does not touch the record", async () => {
    const { say, ctx } = await setup();
    const before = JSON.stringify(ctx.seed.patient);
    const r = await say(STEP9);
    expect(r.reply.body).not.toMatch(/^If you think you are having a medical emergency, call 911 or go to the nearest emergency room now\. This text line/);
    expect(JSON.stringify(ctx.seed.patient)).toBe(before);
  });

  it.each([
    "should I stop taking my medication?",
    "is it safe to take ibuprofen with my blood pressure pill?",
    "I missed my dose yesterday, what should I do?",
    "my blood pressure has been high, should I be worried?",
    "I've been dizzy since yesterday",
    "my ankles are swollen",
    "can I take my pill at night instead?",
    "how many pills should I take?",
  ])("never answers: %s", async (text) => {
    const { say, of } = await setup();
    const r = await say(text);
    expect(r.reply.body).toMatch(/^I can't give medical advice, but I've passed your question to the clinic for a clinician to review\./);
    expect(r.reply.body).not.toBe(SAFE_FALLBACK_REPLY);
    expect(of("clinical_question")).toHaveLength(1);
    expect(of("clinical_question")[0]!.details.question).toBe(text);
  });

  it("a follow-up adds to the same open record instead of a second one", async () => {
    const { say, of } = await setup();
    await say(STEP9);
    const r = await say("also it was 162/101 this morning");
    expect(of("clinical_question")).toHaveLength(1);
    expect(r.patient_message.outcome).toMatchObject({ kind: "handoff_updated" });
    const h = of("clinical_question")[0]!;
    expect(h.details.reported_readings).toBe("around 150/95, 162/101");
    expect(String(h.details.question)).toContain(STEP9);
    expect(String(h.details.question)).toContain("162/101");
    expect(h.source_message_ids).toHaveLength(2);
  });

  it("a refill ask inside a medical question files both, so staff don't have to text back", async () => {
    const { say, of } = await setup();
    const r = await say("can I get a refill? my readings are 150/95, should I take two?");
    expect(r.reply.body).toMatch(/^I've sent a refill request for Lisinopril 10 mg \(once daily\) to staff, pending staff review\. I can't give medical advice, but I've passed your other question/);
    expect(of("refill")).toHaveLength(1);
    expect(of("clinical_question")).toHaveLength(1);
    expect(findReplyViolations(r.reply.body)).toEqual([]);
  });

  it("symptoms mentioned with an appointment ask are kept for staff in the request's note", async () => {
    const { say, of } = await setup();
    await say("I'd like an appointment Tuesday afternoon, I've been dizzy lately");
    const h = of("appointment_request")[0]!;
    expect(h.details).toMatchObject({ reason: "symptoms/concern (see note)", requested_date: "2026-11-10", time_window: "afternoon" });
    expect(h.details.patient_note).toContain("dizzy");
  });

  it("it does not ask Alex again for a reason he already gave as symptoms", async () => {
    const { say } = await setup();
    const r = await say("I'd like an appointment Tuesday afternoon, I've been dizzy lately");
    expect(r.reply.body).not.toMatch(/what('s| is) the appointment for/i);
    expect(r.reply.body).toContain("I've submitted your appointment request");
  });

  it("an emergency inside the same message still wins", async () => {
    const { say, of } = await setup();
    const r = await say("my readings are 150/95 and I have chest pain");
    expect(r.reply.body).toMatch(/This text line is not monitored continuously and cannot help in an emergency\.$/);
    expect(of("clinical_question")).toHaveLength(0);
    expect(of("emergency")).toHaveLength(1);
  });
});

describe("billing and record questions", () => {
  it("a billing dispute becomes a billing handoff with the balance from the record", async () => {
    const { say, of } = await setup();
    const r = await say("I think this charge is wrong, I shouldn't owe $40");
    expect(r.reply.body).toBe("I've passed your billing question to staff. It's pending staff review. Texts aren't monitored continuously, so I can't say when they'll respond.");
    expect(of("billing")[0]!.details).toMatchObject({ balance_amount: 40, balance_reason: "Copay for Oct 6, 2026 visit" });
  });

  it("step 10 still gets an answer, not a handoff", async () => {
    const { say, of } = await setup();
    const r = await say("why do I owe $40?");
    expect(r.reply.body).toContain("Your balance is $40.00");
    expect(of("billing")).toHaveLength(0);
  });

  it.each([
    ["how many refills do I have left?", "Your record shows Lisinopril 10 mg (once daily): no refills remaining. If you'd like, ask me for a refill and I'll send a request to staff."],
    ["what pharmacy do you have on file?", "Your pharmacy on file is Elm Street Pharmacy, (555) 010-0142."],
    ["what meds am I on?", "Your record lists Lisinopril 10 mg (once daily)."],
  ])("%s", async (q, expected) => {
    const { say, of } = await setup();
    expect((await say(q)).reply.body).toBe(expected);
    expect(ctxHandoffs(of)).toBe(0);
  });
});

const ctxHandoffs = (of: (t: string) => unknown[]) => ["refill", "clinical_question", "billing", "other"].reduce((n, t) => n + of(t).length, 0);

describe("helpers", () => {
  it("extractReadings keeps real BP readings and ignores dates", () => {
    expect(extractReadings("around 150/95 all week, then 162/101")).toEqual(["around 150/95", "162/101"]);
    expect(extractReadings("can we do 11/12 or 10/30?")).toEqual([]);
    expect(extractReadings("95/150")).toEqual([]);
  });
  it("hasClinicalCues", () => {
    expect(hasClinicalCues("why do I owe $40?")).toBe(false);
    expect(hasClinicalCues("is it booked yet?")).toBe(false);
    expect(hasClinicalCues("do you take Aetna?")).toBe(false);
    expect(hasClinicalCues("my head hurts")).toBe(true);
  });
});

describe("all replies from this stage pass the safety guard", () => {
  it("none is replaced by the fallback", async () => {
    const { say } = await setup();
    for (const q of [STEP8, STEP8, "I'm almost out, refill please", STEP9, "also 162/101 this morning", "I think the charge is wrong", "how many refills do I have left?", "what meds am I on?"]) {
      const r = await say(q);
      expect(r.reply.body, q).not.toBe(SAFE_FALLBACK_REPLY);
      expect(findReplyViolations(r.reply.body), q).toEqual([]);
    }
  });
});

describe("regressions found by the variations suite: refills without the word 'refill'", () => {
  it.each(["need more lisinopril please", "I'm out of lisinopril", "can I get more pills?", "I need more of my meds"])("files a refill: %s", async (text) => {
    const { say, of } = await setup();
    const r = await say(text);
    expect(r.reply.body).toContain("I've sent a refill request for Lisinopril 10 mg (once daily)");
    expect(of("refill")).toHaveLength(1);
    expect(of("clinical_question")).toHaveLength(0);
  });

  it.each(["should I take more lisinopril?", "can I take more of my meds if my BP is high?"])("but a medical decision about 'more' stays a clinical question: %s", async (text) => {
    const { say, of } = await setup();
    const r = await say(text);
    expect(r.reply.body).toMatch(/^I can't give medical advice/);
    expect(of("clinical_question")).toHaveLength(1);
    expect(of("refill")).toHaveLength(0);
  });
});
