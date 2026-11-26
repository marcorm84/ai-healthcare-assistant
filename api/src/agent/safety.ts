/**
 * Deterministic safety rules. Pure functions, no I/O, no model: these decide
 * the pass/fail cases (emergencies, clinical advice, invented deadlines,
 * false booking claims) so they never depend on an LLM behaving.
 */

// ---- Emergency -------------------------------------------------------------

const EMERGENCY_BASE =
  "If you think you are having a medical emergency, call 911 or go to the nearest emergency room now. " +
  "This {channel} is not monitored continuously and cannot help in an emergency.";

/** The required response, word for word. Voice swaps "This text line" for "This voice service". */
export function emergencyResponse(channel: "text" | "voice" = "text"): string {
  return EMERGENCY_BASE.replace("{channel}", channel === "text" ? "text line" : "voice service");
}

interface EmergencyPattern {
  id: string;
  re: RegExp;
  /** "no chest pain" should not fire. Patterns like "can't breathe" are never negated. */
  negatable: boolean;
}

const P = (id: string, re: RegExp, negatable = true): EmergencyPattern => ({ id, re, negatable });

// Bias: a false alarm costs one canned message; a miss can cost a life.
const EMERGENCY_PATTERNS: EmergencyPattern[] = [
  P("chest_pain", /\bchest\b[^.!?]{0,20}\b(pains?|pressure|tightness|tight|discomfort|crushing|heaviness|hurts?|hurting|squeez\w*)\b/),
  P("chest_pain", /\b(pains?|pressure|tightness|discomfort|squeezing|heaviness)\b[^.!?]{0,15}\b(in|on|across) (my |the |his |her )?chest\b/),
  P("arm_jaw_numb", /\b(arm|jaw)\b[^.!?]{0,20}\b(numb\w*|tingling|heavy|weak)\b/),
  P("arm_jaw_numb", /\b(numb\w*|tingling)\b[^.!?]{0,15}\b(arm|jaw)\b/),
  P("cant_breathe", /\b(can'?t|cannot|can not|unable to|couldn'?t) (breath|breathe|breathing)\b/, false),
  P("breathing_difficulty", /\b(short(ness)? of breath|(hard|difficult|difficulty|trouble|struggling|struggle)( to| with| in)? (breath|breathe|breathing)|gasping)\b/),
  P("heart_attack_stroke_seizure", /\b(having|had) (a|an) (heart attack|stroke|seizure)\b/),
  P("stroke_signs", /\b(face|facial)\b[^.!?]{0,15}\b(droop\w*|sagging|numb\w*)\b/),
  P("stroke_signs", /\bslurr\w* (my |his |her )?(speech|words)\b|\bspeech\b[^.!?]{0,10}\bslurr\w*/),
  P("stroke_signs", /\bsudden(ly)?\b[^.!?]{0,30}\b(weakness|numbness|confus\w*|loss of vision|can'?t see|can'?t speak|trouble speaking)\b/),
  P("seizure", /\b(seizure|seizing|convulsing|convulsions)\b/),
  P("unconscious", /\b(passed out|passing out|fainted|fainting|blacked out|unconscious|unresponsive|collapsed|won'?t wake up)\b/),
  P("severe_bleeding", /\b(bleeding (heavily|a lot|badly|profusely)|won'?t stop bleeding|bleeding won'?t stop|severe bleeding|heavy bleeding|(coughing|vomiting|throwing) up blood)\b/),
  P("allergic_reaction", /\b(throat|tongue|lips?|face)\b[^.!?]{0,20}\b(swelling|swollen|closing|closes)\b|\banaphyla\w*/),
  P("overdose_poisoning", /\b(overdos\w*|took too many|swallowed (a lot|too many)|poison\w*)\b/),
  P("severe_headache", /\bworst headache\b|\bsudden (severe|terrible|intense) headache\b/),
  P("self_harm", /\b(kill(ing)? myself|suicid\w*|end my life|want to die|hurt(ing)? myself|harm(ing)? myself|self[- ]harm|don'?t want to (live|be alive))\b/, false),
  // Someone else (or the patient) not breathing / choking / unresponsive. Never negated: "isn't breathing" IS the emergency.
  P("not_breathing", /\b(not|isn'?t|aren'?t|stopped|stops|stop|no longer|barely|hardly) breathing\b|\bstopped breath\w*\b|\bturning blue\b|\b(lips?|face|skin) (is|are|turned|turning|look\w*|went) blue\b|\bblue lips\b/, false),
  P("choking", /\b(choking|choked|can'?t swallow|something (is )?stuck in (his|her|my|the) throat)\b/, false),
  P("unresponsive_person", /\b(he|she|they|him|her|dad|mom|mother|father|husband|wife|baby|son|daughter|friend|patient|person|someone|man|woman|boy|girl|kid|child|brother|sister|grandma|grandpa|grandmother|grandfather|uncle|aunt)('s| is| isn'?t| is not)? (isn'?t|not|won'?t|stopped) (responding|waking up|conscious|responsive)\b|\b(isn'?t|not|won'?t) (waking up|conscious)\b/, false),
  P("no_pulse", /\b(no pulse|heart (stopped|stopping)|cardiac arrest)\b/, false),
  // Found by a broader battery of real phrasings (14 of 44 were being missed).
  P("overdose_poisoning", /\b(swallowed|took|taken|ate|drank)\b.{0,15}\b(a bunch|a handful|too many|whole bottle|all (of )?(his|her|my|their|the) (pills?|meds?|medication\w*))\b/, false),
  P("self_harm", /\b(end it all|end everything|better off dead|take my own life|thinking about dying|don'?t want to be here)\b/, false),
  P("stroke_signs", /\bcan'?t feel (my|his|her|their) (left|right) (side|arm|leg|face)\b|\bone side of (my|his|her) (face|body)\b/),
  P("chest_pain", /\bchest\b[^.!?]{0,25}\b(crush\w*|squeez\w*|elephant|on fire|being (pressed|sat on))\b/),
  P("unconscious", /\b(feel|feeling|feels|about to|going to) (faint|pass out)\b/),
  P("severe_bleeding", /\b(blood everywhere|lots of blood|so much blood|a lot of blood)\b|\b(vomit\w*|coughing|cough\w*|spitting) (up )?blood\b|\bblood in (my |his |her )?vomit\b/),
  P("cant_breathe", /\b(barely|hardly|can hardly|struggling to|having a hard time) (breathe|breathing)\b/, false),
  P("not_breathing", /\b(baby|child|kid|toddler|infant|he|she|dad|mom|my \w+) (is|looks|went|turned|looking) (blue|gray|grey)\b/, false),
  P("unresponsive_person", /\b(he|she|they|baby|dad|mom|mother|father|husband|wife|son|daughter|friend)('s| is| isn'?t| is not)? ?(isn'?t|not|won'?t|stopped) moving\b|\blimp\b/, false),
  P("dying", /\b(i think|i feel like|feels like) (i'?m|i am|he'?s|she'?s|they'?re) (dying|going to die)\b|\b(i'?m|i am) (dying|going to die)\b/, false),
  P("head_injury", /\b(hit|banged|bumped|struck) (his|her|my|their|the) head\b.{0,40}\b(bleed\w*|unconscious|dizzy|confus\w*|vomit\w*|passed out)\b/),
  // Spanish (patients may write in it). Accents are stripped by normalize(). Same bias: false alarm over a miss.
  P("chest_pain", /\bdolor (en|de) (el |mi )?pecho\b|\bme duele (el )?pecho\b|\bopresion (en|del) (el )?pecho\b/),
  P("cant_breathe", /\bno puedo respirar\b|\bme (falta|ahoga)\b.{0,12}\b(aire|respiracion)\b|\bdificultad (para|al) respirar\b|\bno respira\b/, false),
  P("arm_jaw_numb", /\b(brazo|mandibula)\b.{0,20}\b(dormid\w*|adormecid\w*|entumecid\w*|hormigue\w*)\b/),
  P("heart_attack_stroke_seizure", /\b(infarto|ataque (al|del) corazon|derrame cerebral|convulsion\w*)\b/, false),
  P("unconscious", /\b(se desmayo|me desmaye|desmay\w*|inconsciente|no responde)\b/),
  P("severe_bleeding", /\bsangrado (fuerte|abundante)\b|\bno para de sangrar\b|\bvomit\w* sangre\b/),
  P("overdose_poisoning", /\b(sobredosis|envenen\w*)\b/, false),
  P("cant_breathe", /\bme ahogo\b|\bno puedo respirar\b/, false),
  P("self_harm", /\b(quiero morir|quitarme la vida|suicid\w*|hacerme dano)\b/, false),
  P("explicit_emergency", /\b(911|9-1-1|ambulance|medical emergency|life[- ]threatening|(this|it)('s| is) an emergency|i have an emergency)\b/, false),
];

const NEGATORS = "no|not|never|without|denies|denied|neither|nor|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|haven't|hasn't";
// Tight scope: the negator sits within 3 words of the symptom ("no chest pain").
const NEGATOR = new RegExp(`\\b(${NEGATORS})\\b((?:\\W+\\w+){0,3})\\W*$`);
// A list joined by "or" shares one negator ("don't have any chest pain or trouble breathing").
const NEGATOR_LIST = new RegExp(`\\b(${NEGATORS})\\b((?:\\W+\\w+){0,5}?\\W+or)\\W*$`);
// "not sure if it's chest pain" is uncertainty, not a denial.
const UNCERTAIN = /\b(sure|know|if|whether|certain|think|tell|guess)\b/;

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the match is plainly denied ("no chest pain", "without any chest pain"). */
function isNegated(text: string, matchIndex: number): boolean {
  const clause = text.slice(0, matchIndex).split(/[,;.!?]|\bbut\b|\bhowever\b|\balthough\b|\band\b/).pop() ?? "";
  const m = NEGATOR.exec(clause) ?? NEGATOR_LIST.exec(clause);
  return !!m && !UNCERTAIN.test(m[2] ?? "");
}

export interface EmergencyResult {
  detected: boolean;
  /** Pattern ids that matched, e.g. ["chest_pain", "arm_jaw_numb"]. */
  signals: string[];
}

export function detectEmergency(message: string): EmergencyResult {
  const text = normalize(message);
  const signals = new Set<string>();
  for (const p of EMERGENCY_PATTERNS) {
    for (const m of text.matchAll(new RegExp(p.re.source, "g"))) {
      if (p.negatable && isNegated(text, m.index)) continue;
      signals.add(p.id);
      break;
    }
  }
  return { detected: signals.size > 0, signals: [...signals] };
}

// ---- Outbound reply guard --------------------------------------------------

export type ViolationRule = "clinical_advice" | "review_deadline" | "false_booking_claim";

export interface Violation {
  rule: ViolationRule;
  match: string;
}

const CLINICAL_ADVICE: RegExp[] = [
  /\b(take|taking) (two|2|double|an extra|extra|half|another|one more)\b.{0,20}\b(pills?|tablets?|doses?|lisinopril|medication)\b/,
  /\bdouble (up )?(on )?(your|the) (dose|medication|pills?)\b/,
  /\b(increase|decrease|lower|raise|reduce|skip|stop|halve|adjust|change) (taking )?(your|the) (dose|dosage|medication|medicine|lisinopril|pills?)\b/,
  /\byou should (not )?(take|stop|skip|increase|decrease|lower|double|rest|drink|eat|avoid|exercise|monitor|lie down)\b/,
  /\b(i )?(recommend|advise|suggest) (that )?you (take|stop|skip|increase|lower|rest|drink|monitor)\b/,
  /\b(it'?s|that'?s|this is|that is|it is) (normal|fine|ok|okay|safe|nothing to worry|not (a )?(concern|dangerous|serious|an emergency))\b/,
  /\bnothing to (worry|be concerned)\b|\bdon'?t worry\b/,
  /\b(your|those|these) (blood pressure|bp|readings?|numbers?) (is|are|seems?|sounds?|looks?) (high|low|normal|fine|ok|okay|elevated|concerning|dangerous|too high|too low|good|bad)\b/,
  /\b(sounds like|looks like|could be|might be|may be|probably|likely)\b.{0,40}\b(side effects?|hypertens\w*|infection|anxiety|stress|dehydrat\w*|condition|diagnos\w*)\b/,
];

const REVIEW_VERB = /\b(review|respond|reply|get back|follow up|contact you|call you|reach out|be in touch|hear from|look at)\b/;
const TIMING =
  /\b(within\b.{0,15}\b(minutes?|hours?|days?|weeks?)|(\d+|a|one|two|three|few) (business )?(minutes?|hours?|days?)|shortly|soon|right away|immediately|promptly|today|tomorrow|this (morning|afternoon|evening)|asap|as soon as|same day|next business day|by (the )?end of)\b/;

const BOOKING_CLAIMS: RegExp[] = [
  /\b(i|we)('ve| have)? (just )?(booked|scheduled|confirmed|rescheduled|cancell?ed|approved|renewed|called in|updated your (record|chart|medication))\b/,
  /\byour (request|refill|appointment|recheck|visit|prescription)\b.{0,25}\b(is|has been|was|got|is now) (now )?(booked|confirmed|approved|scheduled|ready|filled|sent)\b/,
];

// Honest statements that merely contain the words ("this is not a confirmed booking").
const SAFE_NEGATIONS = /\b(is not|isn't|was not|wasn't|has not been|hasn't been|not yet|not|isn't yet)( yet)?( been)?( a)? (confirmed|booked|approved|scheduled)( booking)?\b/g;

export function findReplyViolations(reply: string): Violation[] {
  const text = normalize(reply);
  const out: Violation[] = [];

  for (const re of CLINICAL_ADVICE) {
    const m = re.exec(text);
    if (m) out.push({ rule: "clinical_advice", match: m[0] });
  }
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (REVIEW_VERB.test(sentence)) {
      const t = TIMING.exec(sentence);
      if (t) out.push({ rule: "review_deadline", match: t[0] });
    }
  }
  const claimable = text.replace(SAFE_NEGATIONS, " ");
  for (const re of BOOKING_CLAIMS) {
    const m = re.exec(claimable);
    if (m) out.push({ rule: "false_booking_claim", match: m[0] });
  }
  return out;
}

/** Neutral reply used when the agent's own reply breaks a rule. Claims nothing. */
export const SAFE_FALLBACK_REPLY =
  "I'm not able to help with that here. You can call the clinic at (555) 010-0100 during business hours.";

/**
 * Shown to the patient when we couldn't finish handling their message (storage or an internal
 * error). It claims nothing: not that the message or a request was saved, and no timeline.
 */
export const PROCESSING_FAILED_REPLY =
  "I'm sorry, I wasn't able to process your message just now, and I can't confirm that anything was recorded. You can call the clinic at (555) 010-0100 during business hours.";
