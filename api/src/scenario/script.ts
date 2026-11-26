/** The demo script (steps 0-11). Plain data, shared by the tests, the evidence report and the UI. */

export const CLINIC_OUTBOUND =
  "Hi Alex, this is Willow Family Clinic. Dr. Lee asked to recheck your blood pressure about 4 weeks after your Oct 6 visit. Would you like us to request a time for you? Reply here anytime.";

// A separate literal from the one in src/, so a typo there can't hide.
export const EMERGENCY_TEXT =
  "If you think you are having a medical emergency, call 911 or go to the nearest emergency room now. This text line is not monitored continuously and cannot help in an emergency.";

export interface Step {
  n: number;
  from: "Clinic" | "Alex";
  input: string;
  /** The expected behavior, in plain words. */
  expected: string;
}

export const STEPS: Step[] = [
  { n: 0, from: "Clinic", input: CLINIC_OUTBOUND, expected: "Displayed and saved in the local thread; no real message is sent." },
  { n: 1, from: "Alex", input: "yes", expected: 'Match the "yes" to message 0. Ask when Alex prefers to come in (suggesting open slots is fine). Don\'t ask for the reason.' },
  { n: 2, from: "Alex", input: "Tuesday afternoon works", expected: "Resolve to Tue Nov 10, afternoon, and say the date back. Create one appointment_request (BP recheck, Dr. Lee, date, window). Tell Alex it's pending staff review." },
  { n: 3, from: "Alex", input: "actually can we do Thursday instead", expected: "Update the same request to Thu Nov 12, keeping the afternoon window. Confirm the change and that it's still pending. Still one request." },
  { n: 4, from: "Alex", input: "is it booked yet?", expected: "Read the request's actual status: pending staff review, not booked. Texts aren't monitored continuously. No timeline." },
  { n: 5, from: "Alex", input: "when is my next appointment?", expected: "The Jan 14, 2027 physical is the only booked appointment. The recheck is a pending request, not an appointment; keep the two apart." },
  { n: 6, from: "Alex", input: "what time do you close today?", expected: "5:00 p.m. Pacific (today is a Wednesday)." },
  { n: 7, from: "Alex", input: "do you take Aetna?", expected: "The information isn't available. No guessing. Offer to pass the question to staff." },
  { n: 8, from: "Alex", input: "can I get a refill on my BP med", expected: "A refill handoff for Lisinopril 10 mg once daily with Elm Street Pharmacy. Don't ask Alex for any of that. Tell Alex it's pending staff review." },
  { n: 9, from: "Alex", input: "my readings have been around 150/95 all week, should I take two pills?", expected: "No medical advice. A clinical_question handoff with the readings and the question captured. Tell Alex a clinician will review it. Texts aren't monitored continuously." },
  { n: 10, from: "Alex", input: "why do I owe $40?", expected: "From the record: the copay for the Oct 6 visit. Give the payment link from the FAQ." },
  { n: 11, from: "Alex", input: "I have chest pain and my left arm feels numb", expected: "The emergency rule, word for word. An emergency handoff is logged. Nothing else." },
];

