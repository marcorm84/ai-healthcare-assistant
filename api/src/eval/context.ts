import { parseSchedule } from "../agent/dates.js";
import { closedAllDayReason } from "../agent/hours.js";
import { parseFaq } from "../agent/knowledge.js";
import type { SeedData } from "../data/seed.js";
import type { View } from "../scenario/driver.js";
import type { Check } from "../scenario/checks.js";
import { clinicDate } from "../time.js";

/**
 * "Context use": did the agent use what it already knew (the record, the FAQ and the thread)
 * instead of asking again or contradicting it? Scored by assertions on the finished thread.
 */
export function contextChecks(view: View, seed: SeedData): Check[] {
  const { patient, openSlots } = seed;
  const hours = parseFaq(seed.faq).hours;
  const today = clinicDate(view.now);
  const msgs = view.messages;
  const agent = msgs.filter((m) => m.sender === "agent");

  // 1. Replies are matched to the question they answer (so "yes" means something).
  const byId = new Set(msgs.map((m) => m.id));
  const unmatched = msgs.filter(
    (m, i) => m.sender === "patient" && msgs.slice(0, i).some((x) => x.sender !== "patient") && (!m.in_reply_to || !byId.has(m.in_reply_to)),
  );

  // 2. Never ask for something Alex already gave: a day, once a usable day was said earlier.
  const reasked: string[] = [];
  msgs.forEach((m, i) => {
    if (m.sender !== "agent" || !/when would you like to come in|which day (would|works)/i.test(m.body)) return;
    const gaveDay = msgs.slice(0, i).some((p) => {
      if (p.sender !== "patient") return false;
      const s = parseSchedule(p.body, { today, openSlots, suggested: [] });
      return !!s.date && !s.past && !closedAllDayReason(hours, s.date);
    });
    if (gaveDay) reasked.push(m.body.slice(0, 60));
  });

  // 3. Never ask for what the record holds (date of birth, phone, pharmacy, dose, insurance...).
  const askedKnown = agent.filter(
    (m) =>
      m.body.includes("?") &&
      /(date of birth|phone number|which pharmacy|what pharmacy|what dose|what dosage|which medication|what medication|what is your insurance|who is your (doctor|provider))/i.test(m.body),
  );

  // 4. Facts the agent states match the record.
  const wrongFacts: string[] = [];
  for (const m of agent) {
    for (const amt of m.body.matchAll(/\$(\d+(?:\.\d{2})?)/g)) if (Number(amt[1]) !== patient.balance.amount) wrongFacts.push(`amount $${amt[1]}`);
    for (const dr of m.body.matchAll(/Dr\. [A-Z][a-z]+ [A-Z][a-z]+/g)) if (dr[0] !== patient.last_visit.provider) wrongFacts.push(dr[0]);
    for (const dose of m.body.matchAll(/Lisinopril (\d+ mg)/g)) if (dose[1] !== patient.medications[0]?.dose) wrongFacts.push(`dose ${dose[1]}`);
  }

  return [
    { label: "Every reply from Alex is matched to the question it answers", pass: unmatched.length === 0 },
    { label: "Never asks again for a day Alex already gave", pass: reasked.length === 0 },
    { label: "Never asks Alex for what the record already holds", pass: askedKnown.length === 0 },
    { label: "Every fact stated (balance, provider, dose) matches the record", pass: wrongFacts.length === 0 },
  ];
}
