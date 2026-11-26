import { describe, expect, it } from "vitest";
import { detectEmergency, emergencyResponse, findReplyViolations } from "../src/agent/safety.js";

// Copied from the spec, deliberately NOT built from the constant under test.
const SPEC_TEXT =
  "If you think you are having a medical emergency, call 911 or go to the nearest emergency room now. This text line is not monitored continuously and cannot help in an emergency.";
const SPEC_VOICE =
  "If you think you are having a medical emergency, call 911 or go to the nearest emergency room now. This voice service is not monitored continuously and cannot help in an emergency.";

describe("emergency response text", () => {
  it("is word for word what the spec requires (text and voice)", () => {
    expect(emergencyResponse("text")).toBe(SPEC_TEXT);
    expect(emergencyResponse()).toBe(SPEC_TEXT);
    expect(emergencyResponse("voice")).toBe(SPEC_VOICE);
  });

  it("never promises staff review or any follow-up", () => {
    expect(SPEC_TEXT.toLowerCase()).not.toMatch(/staff|review|team|call you|get back/);
  });
});

describe("detectEmergency: must trigger", () => {
  const cases = [
    "I have chest pain and my left arm feels numb", // scenario step 11
    "my chest hurts",
    "There's a crushing pressure in my chest",
    "pain in my chest since this morning",
    "CHEST PAIN!!",
    "my left arm feels numb",
    "my jaw hurts and my arm is tingling",
    "I can't breathe",
    "I can’t breathe", // curly apostrophe
    "cant breathe",
    "no, I can't breathe",
    "I'm having trouble breathing",
    "shortness of breath",
    "I think I'm having a heart attack",
    "my husband is having a stroke",
    "my face is drooping and my speech is slurred",
    "I fainted earlier",
    "I passed out this morning",
    "he's unconscious",
    "I want to kill myself",
    "I took too many pills",
    "I think I overdosed",
    "my throat is swelling up",
    "I'm having a seizure",
    "worst headache of my life",
    "my son swallowed a bunch of pills",
    "my husband took all his pills",
    "I want to end it all",
    "I can't feel my left side",
    "my chest feels like it's being crushed",
    "my heart is racing and I feel faint",
    "there is blood everywhere",
    "I'm vomiting blood",
    "I can barely breathe",
    "my baby is blue",
    "she's not moving",
    "I think I'm dying",
    "my father fell and hit his head and is bleeding",
    "me ahogo",
    "my dad is not breathing",
    "the man is not responding",
    "she is not responding",
    "he stopped breathing",
    "she isn't breathing",
    "my baby is choking",
    "his lips are turning blue",
    "my mom isn't responding",
    "there's no pulse",
    "tengo dolor en el pecho y no puedo respirar",
    "me duele el pecho",
    "mi esposo se desmayo y no responde",
    "creo que tuve un infarto",
    "me duele el pecho y tengo el brazo izquierdo dormido",
    "quiero morir",
    "please call an ambulance",
    "this is a medical emergency",
    "I'm bleeding heavily and it won't stop",
    "I'm coughing up blood",
    "not sure if this is chest pain",
    "I don't think it's chest pain but it hurts",
    "no chest pain but my left arm is numb",
    "I have no chest pain and my left arm is numb",
    "Hi, quick question about parking. Also my chest feels tight.",
  ];
  it.each(cases)("%s", (text) => {
    expect(detectEmergency(text).detected).toBe(true);
  });

  it("reports which signals fired", () => {
    expect(detectEmergency("I have chest pain and my left arm feels numb").signals.sort()).toEqual(["arm_jaw_numb", "chest_pain"]);
  });
});

describe("detectEmergency: must NOT trigger", () => {
  const cases = [
    // the rest of the scenario script
    "yes",
    "Tuesday afternoon works",
    "actually can we do Thursday instead",
    "is it booked yet?",
    "when is my next appointment?",
    "what time do you close today?",
    "do you take Aetna?",
    "can I get a refill on my BP med",
    "my readings have been around 150/95 all week, should I take two pills?",
    "why do I owe $40?",
    // everyday and denied symptoms
    "do you have parking?",
    "what should I bring to my visit",
    "I have no chest pain",
    "I don't have any chest pain or trouble breathing",
    "no shortness of breath, just wanted a BP recheck",
    "I'm not having chest pain, I just want an appointment",
    "I haven't fainted or passed out",
    "my blood pressure recheck is due",
    "I feel fine, no numbness",
    "I took my pills this morning as usual",
    "my son took his pills with breakfast",
    "I'm feeling blue today, can I get an appointment",
    "my phone is dying, I will call you back",
    "the portal is not responding",
    "I hit a lot of traffic and will be late",
    "can I pay with a blue card",
    "Hola, necesito una cita el martes para revisar mi presión arterial",
    "buenos días, ¿a qué hora cierran hoy?",
  ];
  it.each(cases)("%s", (text) => {
    expect(detectEmergency(text)).toEqual({ detected: false, signals: [] });
  });
});

describe("findReplyViolations: must flag", () => {
  const bad: [string, string][] = [
    ["clinical_advice", "Yes, you can take two pills if your pressure is high."],
    ["clinical_advice", "You should double your dose of Lisinopril."],
    ["clinical_advice", "I'd suggest you stop taking your medication."],
    ["clinical_advice", "150/95 is high, but that's normal for some people."],
    ["clinical_advice", "Your blood pressure is elevated."],
    ["clinical_advice", "Don't worry, it's nothing serious."],
    ["clinical_advice", "That sounds like a side effect of the medication."],
    ["clinical_advice", "You should rest and drink water."],
    ["review_deadline", "Staff will review your request within 24 hours."],
    ["review_deadline", "A clinician will get back to you shortly."],
    ["review_deadline", "We'll review this today."],
    ["review_deadline", "Someone will reach out as soon as possible."],
    ["review_deadline", "Staff will follow up tomorrow."],
    ["false_booking_claim", "I've booked your appointment for Tuesday."],
    ["false_booking_claim", "We confirmed your visit."],
    ["false_booking_claim", "Your refill has been approved."],
    ["false_booking_claim", "I approved the refill and called it in."],
    ["false_booking_claim", "Your appointment is booked for Nov 12."],
  ];
  it.each(bad)("%s: %s", (rule, reply) => {
    expect(findReplyViolations(reply).map((v) => v.rule)).toContain(rule);
  });
});

describe("findReplyViolations: legitimate replies pass", () => {
  const good = [
    "Would you like us to request a time? We have Tue Nov 10 at 2:00 p.m. or 3:30 p.m., and Thu Nov 12 at 1:30 p.m. or 4:00 p.m. with Dr. Lee.",
    "I've submitted your request for Tuesday, November 10, in the afternoon. It is pending staff review and is not a confirmed booking.",
    "I've updated your request to Thursday, November 12, in the afternoon. It's still pending staff review and is not booked.",
    "Not yet. Your request is pending staff review and is not booked. Texts aren't monitored continuously, so I can't say when staff will look at it.",
    "Your next booked appointment is the annual physical with Dr. Priya Lee on Jan 14, 2027 at 9:30 a.m. Your blood pressure recheck is only a request pending staff review; it isn't an appointment yet.",
    "We close at 5:00 p.m. Pacific today.",
    "I don't have that information. Would you like me to pass your question about Aetna to staff?",
    "I've sent your refill request for Lisinopril 10 mg once daily to staff, pending review. Your pharmacy on file is Elm Street Pharmacy.",
    "I can't give medical advice. I've passed your readings and your question to the clinic for a clinician to review. Texts aren't monitored continuously.",
    "The $40 is the copay for your Oct 6, 2026 visit. You can pay online at https://pay.example.test/willow, or by phone during business hours.",
    "Please bring a photo ID, your insurance card, and a list of current medications. Please give at least 24 hours' notice to cancel.",
    "Message received.",
  ];
  it.each(good)("%s", (reply) => {
    expect(findReplyViolations(reply)).toEqual([]);
  });
});

describe("detectEmergency: negation scope", () => {
  it("a negator does not reach across an unrelated stretch of words", () => {
    expect(detectEmergency("not feeling well since yesterday with chest pain").detected).toBe(true);
    expect(detectEmergency("I don't have time to explain but I have chest pain").detected).toBe(true);
  });
  it('shares one negator across an "or" list', () => {
    expect(detectEmergency("I don't have any chest pain or trouble breathing").detected).toBe(false);
    expect(detectEmergency("no chest pain or arm numbness").detected).toBe(false);
    expect(detectEmergency("no chest pain or trouble breathing but my left arm is numb").detected).toBe(true);
  });
});
