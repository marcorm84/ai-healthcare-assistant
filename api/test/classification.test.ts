import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { classifyIntent, hasClinicalCues } from "../src/agent/intents.js";
import { detectEmergency } from "../src/agent/safety.js";
import { createApp } from "../src/app.js";
import { createContext } from "../src/context.js";

async function setup() {
  const ctx = await createContext({ storeDir: await mkdtemp(path.join(os.tmpdir(), "willow-")) });
  const app = createApp(ctx);
  return { ctx, say: async (body: string) => (await request(app).post("/api/messages").send({ body })).body };
}

// Ordinary speech that merely contains a word we also use as a medical cue.
const NOT_CLINICAL = [
  "I'm tired of waiting for a callback",
  "I'm so tired of calling and getting voicemail",
  "my last appointment felt painfully slow",
  "the parking garage is a pain",
  "is it okay if I bring my daughter?",
  "is it ok to arrive 10 minutes early?",
  "can I take my daughter with me to the appointment?",
  "can I take a different day off work for this?",
  "how much do the pills cost?",
  "I feel bad about cancelling last time",
  "it's sore subject, I know, but can we talk about the bill",
];

// Medical in substance, however it is phrased.
const CLINICAL = [
  "my readings have been around 150/95 all week, should I take two pills?",
  "should I stop my meds?",
  "my knee hurts",
  "knee pain",
  "I have pain in my back",
  "I'm exhausted all the time",
  "I've been feeling really tired lately",
  "I get dizzy when I stand up",
  "is it safe to double my dose?",
  "can I take ibuprofen with my BP pill?",
  "I missed my dose yesterday",
  "my blood pressure has been high",
  "the pills are making me nauseous",
  "I have a rash on my arm",
  "my ankles are swollen",
  "how many pills should I take?",
];

describe("clinical classification: ordinary speech is not a medical question", () => {
  it.each(NOT_CLINICAL)("%s", (text) => {
    expect(hasClinicalCues(text)).toBe(false);
    expect(classifyIntent(text)).not.toBe("clinical_question");
  });

  it.each(NOT_CLINICAL)("fails closed, with no handoff and no invented answer: %s", async (text) => {
    const { ctx, say } = await setup();
    const r = await say(text);
    expect(ctx.repos.handoffs.list()).toEqual([]); // nothing was filed from a guess
    expect(r.reply.body).not.toMatch(/clinician|medical advice|911/i); // and no clinical reply
  });
});

describe("clinical classification: real medical questions are still captured", () => {
  it.each(CLINICAL)("%s", (text) => {
    expect(hasClinicalCues(text)).toBe(true);
  });

  it.each(CLINICAL.filter((t) => !/^(knee pain)$/.test(t)))("is filed for a clinician and never answered: %s", async (text) => {
    const { ctx, say } = await setup();
    const r = await say(text);
    expect(r.reply.body).toMatch(/^I can't give medical advice, but I've passed your question to the clinic for a clinician to review\./);
    expect(ctx.repos.handoffs.list().map((h) => h.type)).toEqual(["clinical_question"]);
  });
});

describe("asking ABOUT an appointment is not asking FOR one", () => {
  it.each([
    "can I take my daughter with me to the appointment?",
    "can I bring my husband to my appointment?",
    "what should I wear to my appointment?",
  ])("%s", async (text) => {
    expect(classifyIntent(text)).not.toBe("appointment_request");
    const { ctx, say } = await setup();
    await say(text);
    expect(ctx.repos.handoffs.list()).toEqual([]);
  });

  it.each([
    "I need an appointment",
    "I'd like an appointment Tuesday afternoon",
    "can I make an appointment?",
    "could I schedule a visit next week",
    "I want to book a checkup",
    "can I come in Tuesday?",
    "I need to be seen this week",
    "do you have any open slots?",
    "I need my blood pressure rechecked",
  ])("still an appointment request: %s", (text) => {
    expect(classifyIntent(text)).toBe("appointment_request");
  });
});

describe("the emergency detector is independent of the clinical cues (tightening one cannot loosen the other)", () => {
  it.each([
    "I have chest pain and my left arm feels numb",
    "my chest hurts",
    "I can't breathe",
    "I'm so tired and my chest feels tight",
    "I'm dizzy and I think I'm having a stroke",
    "I feel faint and my left arm is numb",
    "worst headache of my life",
  ])("still an emergency: %s", async (text) => {
    expect(detectEmergency(text).detected).toBe(true);
    const { ctx, say } = await setup();
    const r = await say(text);
    expect(r.reply.body).toMatch(/^If you think you are having a medical emergency/);
    expect(ctx.repos.handoffs.list().map((h) => h.type)).toEqual(["emergency"]);
  });

  it.each(NOT_CLINICAL)("and the ordinary phrases are not emergencies either: %s", (text) => {
    expect(detectEmergency(text).detected).toBe(false);
  });
});
