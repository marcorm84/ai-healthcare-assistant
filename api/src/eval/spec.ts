import type { Check } from "../scenario/checks.js";
import { EMERGENCY_TEXT } from "../scenario/script.js";
import type { Category, Run, Variation } from "../scenario/variations.js";

/**
 * A declarative way to write an eval case in a few lines. Default is strict: the handoffs listed
 * are EXACTLY the handoffs that must exist (so a stray extra one fails the case).
 */
export interface Spec {
  /** Exactly these handoffs must exist. `details` values are matched exactly, or by RegExp for strings. */
  handoffs?: { type: string; details?: Record<string, unknown> }[];
  /** No handoff may exist. */
  noHandoffs?: boolean;
  /** The last reply must (not) match. */
  reply?: RegExp;
  notReply?: RegExp;
  /** The last reply must be the emergency text, exactly, and an emergency handoff must exist. */
  emergency?: boolean;
}

export interface CaseInput {
  id: string;
  category: Category;
  title?: string;
  /** What Alex says, in order. */
  messages: string[];
  /** Send the clinic's appointment offer first, so a bare "yes" has a question to answer. */
  offer?: boolean;
  expect: Spec;
}

const matches = (actual: unknown, want: unknown) => (want instanceof RegExp ? want.test(String(actual)) : JSON.stringify(actual) === JSON.stringify(want));

export function specChecks(spec: Spec, r: Run): Check[] {
  const out: Check[] = [];
  const last = r.last.reply.body;
  if (spec.emergency) {
    out.push({ label: "The reply is the emergency text, exactly", pass: last === EMERGENCY_TEXT });
    out.push({ label: "An emergency handoff is logged", pass: r.view.handoffs.some((h) => h.type === "emergency") });
  }
  if (spec.noHandoffs) out.push({ label: "No handoff is created", pass: r.view.handoffs.length === 0 });
  if (spec.handoffs) {
    out.push({ label: `Exactly ${spec.handoffs.length} handoff(s) exist`, pass: r.view.handoffs.length === spec.handoffs.length });
    for (const want of spec.handoffs) {
      const found = r.view.handoffs.find((h) => h.type === want.type && Object.entries(want.details ?? {}).every(([k, v]) => matches(h.details[k], v)));
      out.push({ label: `A ${want.type} with ${JSON.stringify(want.details ?? {})}`, pass: !!found });
    }
  }
  if (spec.reply) out.push({ label: `The reply matches ${spec.reply}`, pass: spec.reply.test(last) });
  if (spec.notReply) out.push({ label: `The reply does not match ${spec.notReply}`, pass: !spec.notReply.test(last) });
  return out;
}

/** Turn a few lines into a full case. */
export function makeCase(c: CaseInput): Variation {
  return {
    id: c.id,
    category: c.category,
    title: c.title ?? c.messages.join(" → "),
    messages: c.messages,
    ...(c.offer ? { offer: true } : {}),
    must: (r) => specChecks(c.expect, r),
    // For an emergency the safety floor is the exact text itself.
    ...(c.expect.emergency ? { safe: (r: Run) => [{ label: "The emergency text is sent", pass: r.last.reply.body === EMERGENCY_TEXT }] } : {}),
  };
}
