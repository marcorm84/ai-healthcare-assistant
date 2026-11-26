/** Rule-based intent detection. Order matters: the first matching rule wins. */
export type Intent =
  | "next_appointment"
  | "request_status"
  | "change_booked_appointment"
  | "appointment_request"
  | "billing_request"
  | "clinical_question"
  | "refill_info"
  | "refill_request"
  | "medications_on_file"
  | "pharmacy_on_file"
  | "insurance_acceptance"
  | "insurance_on_file"
  | "balance"
  | "hours"
  | "address"
  | "phone"
  | "texting"
  | "what_to_bring"
  | "cancellation_policy"
  | "greeting"
  | "help"
  | "thanks"
  | "unknown";

const DURATION =
  /\b(all (day|week|month|night)|(for|over) (the )?(last |past )?(\d+|a|an|one|two|three|four|few|couple of) (hours?|days?|weeks?|months?)|since \w+( \w+)?|(this|last) (week|month)|yesterday|(\d+) (hours?|days?|weeks?|months?))\b/i;

/** "all week", "for 3 days": how long a symptom or reading has been going on. */
export function extractDuration(text: string): string | null {
  return DURATION.exec(text)?.[0] ?? null;
}

/** Blood-pressure-looking numbers ("150/95"). Dates like "11/12" are not readings. */
export function extractReadings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:\b(around|about|roughly|approximately)\s+|~\s*)?\b(\d{2,3})\s*\/\s*(\d{2,3})\b/gi)) {
    const [sys, dia] = [Number(m[2]), Number(m[3])];
    if (sys >= 70 && sys <= 260 && dia >= 40 && dia <= 150 && sys > dia) out.push(`${m[1] ? m[1].toLowerCase() + " " : ""}${sys}/${dia}`);
  }
  return out;
}

// Words that only mean "medical" next to a body part or a first-person feeling. On their own
// ("tired of waiting", "painfully slow", "a pain to park") they are ordinary speech.
const BODY = "head|back|knee|knees|leg|legs|arm|arms|foot|feet|ankle|ankles|stomach|belly|neck|shoulder|shoulders|chest|throat|eyes?|ears?|teeth|tooth|jaw|joints?|muscles?|hands?|hips?|abdomen";

/** Always a medical question or symptom. */
const CLINICAL_CUES: RegExp[] = [
  /\bshould i\b.{0,40}\b(take|stop|skip|increase|decrease|double|lower|raise|worry|be worried)\b/,
  /\bshould i\b.{0,20}\b(go to|see)\b.{0,15}\b(er|emergency|hospital|doctor|specialist|urgent care)\b/,
  /\bshould i\b.{0,20}\bchange\b.{0,15}\b(dose|dosage|medication|medicine|pills?|meds?)\b/,
  /\b(missed|forgot|skipped)\b.{0,20}\b(dose|pill|pills|medication|med|meds)\b/,
  /\bhow (many|much)\b(?!.{0,15}\b(cost|price|charge))\b.{0,20}\b(pills?|doses?|mg|tablets?)\b/,
  /\b(side effects?|dizz\w*|lightheaded|headaches?|nausea|nauseous|swollen|swelling|palpitations|blurry|blurred|fever|rash|vomit\w*|cough\w*|symptoms?)\b/,
  new RegExp(`\\b(${BODY})\\b.{0,20}\\b(hurts?|hurting|aches?|aching|sore|pain|painful)\\b`),
  /\b(pain|ache|aching)\b.{0,12}\b(in|on|at) (my|the)\b/,
  /\bi('m| am|'ve been| have been) (in pain|(so |very |really |constantly |always )?(tired|exhausted|fatigued)(?!\s+(of|with|from|waiting)))\b/,
  /\bi(?:'ve| have|'m| am)? (?:been )?(?:feel|felt|feeling)\b.{0,10}\b(tired|exhausted|weak|sick|unwell)\b/,
  /\bmy (blood pressure|bp|readings?|numbers?)\b.{0,40}\b(high|low|elevated|up|down|spik\w+|climb\w+|drop\w+|running|above|over|under)\b/,
  /\b(medication|medicine|pills?|meds?)\b.{0,30}\b(not working|making me|causing|gives? me|doesn'?t seem)\b/,
];

/** Medical only when the message is also about medication, readings or symptoms. */
const MED_CONTEXT = /\b(pills?|meds?|medications?|medicines?|doses?|dosage|mg|tablets?|blood pressure|bp|readings?|heart|chest|symptoms?|lisinopril|side effects?)\b/;
const NEEDS_MED_CONTEXT: RegExp[] = [
  /\b(is it|is this|are these|would it be)\b.{0,10}\b(safe|normal|ok|okay|dangerous|bad)\b/,
  /\b(can|may) i\b.{0,30}\b(take|mix|combine|drink|eat|stop|skip)\b/,
];

/** Symptoms, readings or "should I take..." questions: for a clinician, never for the agent. */
export function hasClinicalCues(text: string): boolean {
  const t = text.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  return (
    extractReadings(t).length > 0 ||
    CLINICAL_CUES.some((re) => re.test(t)) ||
    (MED_CONTEXT.test(t) && NEEDS_MED_CONTEXT.some((re) => re.test(t)))
  );
}

const BILLING_DISPUTE = /\b(dispute|disagree|wrong|incorrect|mistake|error|overcharged?|waive|payment plan|refund|can'?t afford|shouldn'?t (owe|be charged))\b/;
const BILLING_CONTEXT = /\b(bill|balance|charge[ds]?|copay|co-pay|owe|payment|invoice|\$\d+)/;

type Rule = [Intent, RegExp | ((t: string) => boolean)];

const RULES: Rule[] = [
  ["next_appointment", /\bwhat (time|day|date)\b.{0,20}\bmy\b.{0,15}\b(appointment|visit)\b|\b(next|upcoming)\b.{0,30}\b(appointment|visit)\b|\bwhen('s| is| are)\b.{0,15}\bmy\b.{0,15}\b(appointment|visit)s?\b|\bdo i have (an|any)\b.{0,15}\b(appointment|visit)s?\b/],
  ["request_status", /\b(booked|confirmed|scheduled|approved)\s+yet\b|\b(is|has)\b.{0,20}\b(it|that|my request|my appointment|the request)\b.{0,15}\b(booked|confirmed|scheduled|approved|done)\b|\bany (update|news)\b|\bstatus of (my|the)\b|\bdid (you|they|staff) (book|confirm|schedule)\b/],
  ["change_booked_appointment", /\b(cancel|reschedul\w*)\b/],
  // Asking to GET an appointment. "Can I bring my daughter to my appointment?" asks *about* one and is not this.
  ["appointment_request", /\b(re-?check\w*|follow[- ]?up)\b.{0,30}\b(blood pressure|bp)\b|\b(blood pressure|bp)\b.{0,30}\b(re-?check\w*|follow[- ]?up|check)\b|\b(need|want|like|looking for|hoping for|request)\b.{0,15}\b(an?|another|new)\b.{0,15}\b(appointments?|appts?|visit|time|slot|check-?up|physical)\b|\b(schedule|book|set up|make|get|arrange|request|have)\b.{0,20}\b(an?|another|new|my)\b.{0,15}\b(appointments?|appts?|visit|time|slot|check-?up|physical)\b|\b(need|want|would like|can|could|may)\b.{0,12}\b(come in|be seen|stop by)\b|\bsee (dr\.?|doctor|dr lee)\b|\b(any|available|open|earliest)\b.{0,15}\b(appointments?|slots?|openings?)\b|\b(appointments?|slots?|openings?)\b.{0,15}\b(available|open|free)\b/],
  ["billing_request", (t) => BILLING_DISPUTE.test(t) && BILLING_CONTEXT.test(t)],
  ["clinical_question", hasClinicalCues],
  ["refill_info", /\bhow many refills\b|\brefills? (left|remaining)\b|\bremaining refills\b/],
  ["refill_request", /\b(refills?|re-?fill(s|ed)?|renew\w*)\b|\b(need|want|get|have)\b.{0,10}\bmore\b.{0,12}\b(pills?|meds?|medications?|prescription)\b|\b(running|ran|am|i'm) (out|low)\b.{0,15}\b(of )?(my )?(med\w*|pills?|lisinopril)\b/],
  ["insurance_acceptance", /\b(take|accept|in[- ]?network|cover|covers|work with)\b.{0,40}\b(insurance|plan|aetna|cigna|humana|kaiser|anthem|medicare|medicaid|united ?healthcare|blue ?(shield|cross)|tricare)\b|\b(aetna|cigna|humana|kaiser|anthem|medicaid|united ?healthcare|tricare)\b/],
  ["medications_on_file", /\b(what|which)\b.{0,15}\b(meds|medications?|medicines?|prescriptions?)\b.{0,15}\b(am i|do i|i'm|i am)\b|\bmy (meds|medications|prescriptions)\b.{0,10}\b(list|on file)\b|\blist of my (meds|medications)\b/],
  ["pharmacy_on_file", /\b(which|what)\b.{0,10}\bpharmacy\b|\bpharmacy\b.{0,15}\b(on file|do you have)\b/],
  ["insurance_on_file", /\b(my|what|which)\b.{0,15}\b(insurance|plan|payer)\b/],
  ["balance", /\b(owe|balance|bill|billed|copay|co-pay|charge[ds]?|invoice|pay|payment)\b/],
  ["hours", /\b(hours?|open|opens|opening|close|closes|closing|closed)\b/],
  ["address", /\b(address|located|location|directions|parking|park|where (are|is) (you|the clinic))\b/],
  ["phone", /\b(phone number|number to call|call (you|the clinic|the office)|your number)\b/],
  ["texting", /\b(read|respond to|reply to|answer|monitor\w*|check)\b.{0,20}\b(texts?|messages?)\b|\b(texts?|texting)\b.{0,40}\b(monitor\w*|read|respon\w*|repl\w*|answer\w*|check\w*|how (fast|long|quick\w*))\b|\bhow (fast|quickly|soon)\b.{0,20}\b(reply|respond|answer)\b/],
  ["what_to_bring", /\b(bring|what do i need)\b/],
  ["cancellation_policy", /\bcancel\w*\b.{0,30}\b(policy|notice|fee|charge)\b|\b(policy|notice|fee)\b.{0,30}\bcancel\w*\b/],
  // A bare greeting or "what can you do?". Anchored to the whole message so "hello, I need a refill" is never swallowed.
  ["greeting", /^\s*(hi|hello|hey|hiya|howdy|hola|good (morning|afternoon|evening))( there| alex| clinic| team)?[\s!.,?]*$/],
  ["help", /^\s*(help|help me|i need help|can you help( me)?|what can you (do|help (me )?with)|how does this work|what do you do)[\s!.,?]*$/],
  ["thanks", /^\s*(thanks|thank you|thx|ty|great,? thanks|ok,? thanks|cool,? thanks)\b/],
];

export function classifyIntent(text: string): Intent {
  const t = text.toLowerCase().replace(/[‘’]/g, "'");
  return RULES.find(([, rule]) => (typeof rule === "function" ? rule(t) : rule.test(t)))?.[0] ?? "unknown";
}

const YES_WORDS = new Set("yes yeah yep yup sure ok okay y please go ahead do it that works sounds good thanks thank you definitely absolutely of course thing".split(" "));
const YES_CORE = new Set("yes yeah yep yup sure ok okay y please ahead works good definitely absolutely course".split(" "));
const NO_WORDS = new Set("no nope nah not now never mind thanks thank you don't do need it that's thats fine good".split(" "));
const NO_CORE = new Set("no nope nah not never mind don't".split(" "));

/**
 * "yes"/"no" replies to a question we asked. The *whole* message must be an answer:
 * "ok Tuesday afternoon then" is a new message (it carries content), not a "yes".
 */
export function parseYesNo(text: string): "yes" | "no" | null {
  const words = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return null;
  if (words.every((w) => YES_WORDS.has(w)) && words.some((w) => YES_CORE.has(w))) return "yes";
  if (words.every((w) => NO_WORDS.has(w)) && words.some((w) => NO_CORE.has(w))) return "no";
  return null;
}
