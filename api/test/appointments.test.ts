import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { findReplyViolations, SAFE_FALLBACK_REPLY } from "../src/agent/safety.js";
import { createApp } from "../src/app.js";
import { createContext } from "../src/context.js";

const STEP0 =
  "Hi Alex, this is Willow Family Clinic. Dr. Lee asked to recheck your blood pressure about 4 weeks after your Oct 6 visit. Would you like us to request a time for you? Reply here anytime.";

async function setup(storeDir?: string) {
  const ctx = await createContext({ storeDir: storeDir ?? (await mkdtemp(path.join(os.tmpdir(), "willow-"))) });
  const app = createApp(ctx);
  const say = async (body: string) => (await request(app).post("/api/messages").send({ body })).body;
  const clinic = async (body = STEP0, awaiting_kind = "appointment_offer") =>
    (await request(app).post("/api/thread/clinic-messages").send({ body, awaiting_kind })).body;
  const appts = () => ctx.repos.handoffs.list().filter((h) => h.type === "appointment_request");
  return { ctx, app, say, clinic, appts };
}

describe("scenario steps 0-5: the appointment request", () => {
  it("runs the whole script: one request, updated in place, pending the whole time", async () => {
    const { ctx, say, clinic, appts } = await setup();

    // 0: clinic outbound, saved in the thread
    const m0 = (await clinic()).message;
    expect(m0).toMatchObject({ sender: "clinic", body: STEP0 });

    // 1: "yes" is matched to message 0; asks when; suggests real slots; does NOT ask for the reason
    const s1 = await say("yes");
    expect(s1.patient_message.in_reply_to).toBe(m0.id);
    expect(s1.reply.body).toBe(
      "Great, I can send a request to staff. When would you like to come in? " +
        "Open times with Dr. Priya Lee: Tuesday, November 10 at 2:00 p.m. or 3:30 p.m.; Thursday, November 12 at 1:30 p.m. or 4:00 p.m. " +
        "You can pick one of these, or tell me a day and time of day that works.",
    );
    expect(s1.reply.body.toLowerCase()).not.toMatch(/what('s| is) the appointment for|reason/);
    expect(appts()).toHaveLength(0);

    // 2: resolves to Tue Nov 10 afternoon, says the date back, creates ONE request
    const s2 = await say("Tuesday afternoon works");
    expect(s2.reply.body).toBe(
      "I've submitted your BP recheck request with Dr. Priya Lee for Tuesday, November 10, in the afternoon. It's pending staff review and is not a confirmed booking.",
    );
    expect(appts()).toHaveLength(1);
    const [h] = appts();
    expect(h).toMatchObject({ patient_id: "pt_001", type: "appointment_request", status: "pending_staff" });
    expect(h!.details).toEqual({
      reason: "BP recheck",
      provider: "Dr. Priya Lee",
      requested_date: "2026-11-10",
      time_window: "afternoon",
      requested_slot: null, // Alex didn't choose a specific slot
      patient_note: null,
    });
    expect(h!.source_message_ids).toContain(s2.patient_message.id);
    expect(s2.patient_message.outcome).toEqual({ kind: "handoff_created", handoff_id: h!.id });

    // 3: same request moves to Thu Nov 12, keeps the afternoon window, still pending, still one record
    const s3 = await say("actually can we do Thursday instead");
    expect(s3.reply.body).toBe(
      "I've updated your BP recheck request to Thursday, November 12, in the afternoon. It's still pending staff review and is not a confirmed booking.",
    );
    expect(appts()).toHaveLength(1);
    const updated = appts()[0]!;
    expect(updated.id).toBe(h!.id);
    expect(updated).toMatchObject({ status: "pending_staff", details: { requested_date: "2026-11-12", time_window: "afternoon", reason: "BP recheck" } });
    expect(updated.source_message_ids).toEqual([...h!.source_message_ids, s3.patient_message.id]);
    expect(s3.patient_message.outcome).toEqual({ kind: "handoff_updated", handoff_id: h!.id });

    // 4: reads the real status: pending, not booked, no timeline
    const s4 = await say("is it booked yet?");
    expect(s4.reply.body).toBe(
      "Not yet. Your BP recheck request for Thursday, November 12, in the afternoon is pending staff review and is not booked. " +
        "Texts aren't monitored continuously, so I can't say when staff will get to it.",
    );
    expect(s4.reply.body).not.toMatch(/\b(soon|shortly|today|tomorrow|hours?|days?)\b/i);

    // 5: the booked physical is the appointment; the recheck stays a request
    const s5 = await say("when is my next appointment?");
    expect(s5.reply.body).toContain("Your next booked appointment is the annual physical with Dr. Priya Lee on Thursday, January 14, 2027 at 9:30 a.m.");
    expect(s5.reply.body).toContain("your BP recheck request for Thursday, November 12 (afternoon) is still pending staff review. It isn't a booked appointment.");

    // nothing in the whole conversation tripped the safety guard, and the record was never touched
    const replies = ctx.repos.messages.listByThread(s5.thread.id).filter((m) => m.sender === "agent");
    for (const r of replies) {
      expect(r.body).not.toBe(SAFE_FALLBACK_REPLY);
      expect(findReplyViolations(r.body)).toEqual([]);
    }
    expect(appts()).toHaveLength(1);
  });

  it("after a restart in the middle of step 1 -> 2, the conversation carries on", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "willow-"));
    const a = await setup(dir);
    await a.clinic();
    await a.say("yes");

    const b = await setup(dir); // new process, same files
    const r = await b.say("Tuesday afternoon works");
    expect(r.reply.body).toContain("I've submitted your BP recheck request");
    expect(b.appts()).toHaveLength(1);
  });
});

describe("choices the script allows", () => {
  it("a chosen slot is recorded as a preference and the reply says it does not hold the slot", async () => {
    const { say, clinic, appts } = await setup();
    await clinic();
    await say("yes");
    const r = await say("Tuesday at 3:30pm");
    expect(appts()[0]!.details).toMatchObject({ requested_date: "2026-11-10", time_window: "afternoon", requested_slot: { date: "2026-11-10", start: "15:30" } });
    expect(r.reply.body).toBe(
      "I've submitted your BP recheck request with Dr. Priya Lee for Tuesday, November 10 at 3:30 p.m. It's pending staff review and is not a confirmed booking. Choosing a time doesn't hold the slot.",
    );
  });

  it("'the second one' picks from the slots we listed", async () => {
    const { say, clinic, appts } = await setup();
    await clinic();
    await say("yes");
    await say("the second one");
    expect(appts()[0]!.details.requested_slot).toMatchObject({ date: "2026-11-10", start: "15:30" });
  });

  it("changing the date drops a slot that no longer fits; changing only the window keeps the date", async () => {
    const { say, clinic, appts } = await setup();
    await clinic();
    await say("yes");
    await say("Tuesday at 2pm");
    await say("actually Thursday");
    expect(appts()[0]!.details).toMatchObject({ requested_date: "2026-11-12", requested_slot: null, time_window: "afternoon" });
    const r = await say("actually the morning is better");
    expect(appts()[0]!.details).toMatchObject({ requested_date: "2026-11-12", time_window: "morning" });
    expect(r.reply.body).toContain("Thursday, November 12, in the morning");
    expect(appts()).toHaveLength(1);
  });

  it("repeating the same thing changes nothing and says so", async () => {
    const { say, clinic, appts } = await setup();
    await clinic();
    await say("yes");
    await say("Tuesday afternoon");
    const r = await say("Tuesday afternoon");
    expect(r.reply.body).toMatch(/^That's already how your BP recheck request is set/);
    expect(appts()).toHaveLength(1);
    expect(appts()[0]!.source_message_ids).toHaveLength(2);
  });

  it("skipping 'yes' and answering with a time right away works too", async () => {
    const { say, clinic, appts } = await setup();
    await clinic();
    const r = await say("Tuesday afternoon works");
    expect(r.reply.body).toContain("I've submitted your BP recheck request");
    expect(appts()).toHaveLength(1);
  });

  it("a day with no time of day is still captured (window 'any') and Alex is told they can narrow it", async () => {
    const { say, clinic, appts } = await setup();
    await clinic();
    await say("yes");
    const r = await say("Tuesday");
    expect(appts()[0]!.details.time_window).toBe("any");
    expect(r.reply.body).toContain("any time of day works");
  });

  it("answering 'no' to the offer files nothing", async () => {
    const { say, clinic, appts } = await setup();
    await clinic();
    const r = await say("no thanks");
    expect(r.reply.body).toMatch(/No problem/);
    expect(appts()).toHaveLength(0);
  });
});

describe("unprompted requests (no clinic message first)", () => {
  it("'I need my blood pressure rechecked. Tuesday works.' creates the request with no extra questions", async () => {
    const { say, appts } = await setup();
    const r = await say("I need my blood pressure rechecked. Tuesday works.");
    expect(r.reply.body).toContain("I've submitted your BP recheck request");
    expect(appts()[0]!.details).toMatchObject({ reason: "BP recheck", requested_date: "2026-11-10", time_window: "any" });
  });

  it("a generic request asks for the reason once, and remembers the day already given", async () => {
    const { say, appts } = await setup();
    const a = await say("I'd like an appointment Tuesday afternoon");
    expect(a.reply.body).toBe("What's the appointment for?");
    expect(appts()).toHaveLength(0);
    const b = await say("knee pain");
    expect(b.reply.body).toContain("I've submitted your knee pain request with Dr. Priya Lee for Tuesday, November 10, in the afternoon");
    expect(appts()[0]!.details).toMatchObject({ reason: "knee pain", requested_date: "2026-11-10", time_window: "afternoon" });
  });

  it("with no day given, it asks for one and lists the real open times", async () => {
    const { say } = await setup();
    const r = await say("I need my blood pressure rechecked");
    expect(r.reply.body).toBe(
      "When would you like to come in? Open times with Dr. Priya Lee: Tuesday, November 10 at 2:00 p.m. or 3:30 p.m.; Thursday, November 12 at 1:30 p.m. or 4:00 p.m.",
    );
    expect(r.thread.awaiting).toMatchObject({ kind: "appointment_time" });
  });

  it("asking again while a request is open does not create a second one", async () => {
    const { say, appts } = await setup();
    await say("I need my blood pressure rechecked. Tuesday works.");
    const r = await say("I need my blood pressure rechecked");
    expect(r.reply.body).toMatch(/You already have a BP recheck request pending/);
    expect(appts()).toHaveLength(1);
  });

  it("a different reason is a separate request", async () => {
    const { say, appts } = await setup();
    await say("I need my blood pressure rechecked. Tuesday works.");
    await say("I'd like an appointment for a rash on Thursday");
    expect(appts().map((h) => h.details.reason)).toEqual(["BP recheck", "rash"]);
  });
});

describe("dates the clinic can't use", () => {
  it.each([
    ["Saturday works", "We're closed on Saturday, November 7 (it's a weekend). Which weekday works for you?"],
    ["Nov 3", "That date has already passed. Which day would you like? Open times"],
    ["next week", "Which day would you like to come in? Open times"],
    ["Tuesday at 7pm", "We're open 9:00 a.m.–5:00 p.m. Pacific. What time within those hours works for you?"],
    ["Tuesday evening", "We're open 9:00 a.m.–5:00 p.m. Pacific. What time within those hours works for you?"],
  ])("%s -> asks again, saves nothing", async (message, startsWith) => {
    const { say, clinic, appts } = await setup();
    await clinic();
    await say("yes");
    const r = await say(message);
    expect(r.reply.body.startsWith(startsWith)).toBe(true);
    expect(appts()).toHaveLength(0);
    expect(r.thread.awaiting).toMatchObject({ kind: "appointment_time" });
  });

  it("a holiday is closed too (Veterans Day, Wed Nov 11)", async () => {
    const { say, appts } = await setup();
    const r = await say("I need an appointment on Nov 11");
    expect(r.reply.body).toContain("We're closed on Wednesday, November 11 (Veterans Day, a federal holiday)");
    expect(appts()).toHaveLength(0);
  });

  it("after being asked again, a valid answer completes the request", async () => {
    const { say, clinic, appts } = await setup();
    await clinic();
    await say("yes");
    await say("Saturday works");
    const r = await say("ok Tuesday afternoon then");
    expect(r.reply.body).toContain("I've submitted your BP recheck request");
    expect(appts()[0]!.details.requested_date).toBe("2026-11-10");
  });

  it("only a weekday is offered when the afternoon alone is given first", async () => {
    const { say, clinic, appts } = await setup();
    await clinic();
    await say("yes");
    const a = await say("afternoons are better for me");
    expect(a.reply.body.startsWith("Got it, afternoons work. Which day would you like?")).toBe(true);
    await say("Thursday");
    expect(appts()[0]!.details).toMatchObject({ requested_date: "2026-11-12", time_window: "afternoon" }); // window remembered
  });
});

describe("request status (step 4) reflects what staff really did", () => {
  const withRequest = async () => {
    const s = await setup();
    await s.say("I need my blood pressure rechecked. Tuesday afternoon works.");
    return s;
  };
  it("pending", async () => {
    const { say } = await withRequest();
    expect((await say("any update?")).reply.body).toMatch(/^Not yet\. Your BP recheck request for Tuesday, November 10, in the afternoon is pending staff review and is not booked\./);
  });
  it.each([
    ["approved", /^Staff has approved your BP recheck request .* I don't see it as a booked appointment in your record yet\.$/],
    ["completed", /^Staff has marked your BP recheck request .* as completed\./],
    ["rejected", /^Staff closed your BP recheck request .* without approving it\.$/],
  ] as const)("%s", async (status, pattern) => {
    const { ctx, say, appts } = await withRequest();
    await ctx.repos.handoffs.update(appts()[0]!.id, { status });
    const reply = (await say("is it booked yet?")).reply.body;
    expect(reply).toMatch(pattern);
    expect(findReplyViolations(reply)).toEqual([]);
  });
  it("a closed request is never edited by a later message: a new one is created", async () => {
    const { ctx, say, appts } = await withRequest();
    await ctx.repos.handoffs.update(appts()[0]!.id, { status: "completed" });
    await say("actually can we do Thursday instead"); // nothing open to change, no reason known -> asks
    expect(appts()).toHaveLength(1);
    expect(appts()[0]!.status).toBe("completed");
  });
  it("no request at all", async () => {
    const { say } = await setup();
    expect((await say("is it booked yet?")).reply.body).toBe("I don't see an appointment request from you. Would you like me to request a time?");
  });
});

describe("does not hijack other messages", () => {
  it("questions mentioning a weekday don't change an open request", async () => {
    const { say, appts } = await setup();
    await say("I need my blood pressure rechecked. Tuesday afternoon works.");
    const r = await say("are you open Thursday?");
    expect(r.reply.body).not.toMatch(/updated/);
    expect(appts()[0]!.details.requested_date).toBe("2026-11-10");
    await say("do you offer flu shots on Thursday?");
    expect(appts()[0]!.details.requested_date).toBe("2026-11-10");
  });

  it("an unrelated reply while asked 'when?' is answered normally and the question is dropped", async () => {
    const { say, clinic, appts } = await setup();
    await clinic();
    await say("yes");
    const r = await say("what time do you close today?");
    expect(r.reply.body).toBe("We close at 5:00 p.m. Pacific today (Wednesday).");
    expect(r.thread.awaiting).toBeNull();
    expect(appts()).toHaveLength(0);
  });

  it("cancelling or rescheduling is passed to staff, never done", async () => {
    const { say, appts } = await setup();
    const r = await say("I need to cancel my appointment");
    expect(r.reply.body).toBe("I can't cancel or reschedule appointments myself; only staff can. Would you like me to pass your question to staff?");
    expect(appts()).toHaveLength(0);
  });

  it("emergency still wins mid-flow", async () => {
    const { say, clinic, appts, ctx } = await setup();
    await clinic();
    await say("yes");
    const r = await say("Tuesday works but I have chest pain and my left arm is numb");
    expect(r.reply.body).toMatch(/^If you think you are having a medical emergency, call 911/);
    expect(appts()).toHaveLength(0);
    expect(ctx.repos.handoffs.list().map((h) => h.type)).toEqual(["emergency"]);
  });
});

describe("the 'what is it for?' question only accepts a plain reason", () => {
  it("a question in reply is answered as a question, and no request is created from it", async () => {
    const { say, appts } = await setup();
    const a = await say("I'd like an appointment Tuesday afternoon");
    expect(a.reply.body).toBe("What's the appointment for?");
    const b = await say("is it booked yet?");
    expect(b.reply.body).toBe("I don't see an appointment request from you. Would you like me to request a time?");
    expect(appts()).toHaveLength(0);
    const c = await say("what time do you close today?");
    expect(c.reply.body).toBe("We close at 5:00 p.m. Pacific today (Wednesday).");
    expect(appts()).toHaveLength(0);
  });

  it("the next-appointment answer words a flexible window readably", async () => {
    const { say } = await setup();
    await say("I need my blood pressure rechecked. Tuesday works.");
    const r = await say("when is my next appointment?");
    expect(r.reply.body).toContain("your BP recheck request for Tuesday, November 10 (any time of day) is still pending staff review.");
  });
});

describe("restart in the middle of the script (steps 2 -> 3)", () => {
  it("the request created before the restart is the one updated after it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "willow-"));
    const a = await setup(dir);
    await a.clinic();
    await a.say("yes");
    await a.say("Tuesday afternoon works");
    const id = a.appts()[0]!.id;

    const b = await setup(dir);
    const r = await b.say("actually can we do Thursday instead");
    expect(r.reply.body).toContain("I've updated your BP recheck request to Thursday, November 12, in the afternoon");
    expect(b.appts().map((h) => h.id)).toEqual([id]);
    expect((await b.say("is it booked yet?")).reply.body).toMatch(/^Not yet\. Your BP recheck request for Thursday, November 12/);
  });
});

describe("regressions found by the variations suite", () => {
  it('"Never mind about Tuesday, how about the following Monday?" updates the same request to Mon Nov 16 (no bogus "tuesday" request)', async () => {
    const { say, appts } = await setup();
    await say("I need my blood pressure rechecked. Tuesday afternoon works.");
    const r = await say("Never mind about Tuesday, how about the following Monday?");
    expect(appts()).toHaveLength(1);
    expect(appts()[0]!.details).toMatchObject({ reason: "BP recheck", requested_date: "2026-11-16", time_window: "afternoon" });
    expect(r.reply.body).toBe("I've updated your BP recheck request to Monday, November 16, in the afternoon. It's still pending staff review and is not a confirmed booking.");
  });

  it('"update my appointment to <past date>" is validated like any other change: past dates are refused, the request is untouched', async () => {
    const { say, appts } = await setup();
    await say("I need my blood pressure rechecked. Tuesday afternoon works.");
    const before = appts()[0]!.details.requested_date;
    for (const text of ["i want to update my appointment to Nov 2", "please modify my appointment to Nov 2", "can you push it to Nov 2"]) {
      const r = await say(text);
      expect(r.reply.body, text).toMatch(/^That date has already passed\. Which day would you like\?/);
    }
    expect(appts()).toHaveLength(1);
    expect(appts()[0]!.details.requested_date).toBe(before);
  });

  it("a date or day is never taken as the reason for an appointment", async () => {
    const { say, appts } = await setup();
    for (const text of ["I'd like an appointment about Tuesday", "an appointment for next Friday please", "I need to come in for tomorrow"]) {
      const r = await say(text);
      expect(r.reply.body.toLowerCase(), text).not.toMatch(/your (tuesday|next friday|tomorrow|friday) request/);
    }
    for (const h of appts()) expect(String(h.details.reason)).not.toMatch(/tuesday|friday|tomorrow|next|following/i);
  });

  it('"the following Monday" with no request to be relative to asks for a day instead of guessing', async () => {
    const { say, appts } = await setup();
    const r = await say("I need my blood pressure rechecked the following Monday");
    expect(appts()).toHaveLength(0);
    expect(r.reply.body).toMatch(/^Which day would you like to come in\?/);
  });
});
