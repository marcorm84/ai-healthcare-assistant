import type { Variation } from "../scenario/variations.js";

/**
 * Add a case here in a few lines, then run "npm run eval". Example (uncomment and edit):
 *
 *   makeCase({
 *     id: "my-new-case",
 *     category: "refill",
 *     messages: ["can you send a refill to the pharmacy please"],
 *     expect: { handoffs: [{ type: "refill", details: { medication: "Lisinopril" } }], notReply: /\?/ },
 *   }),
 *
 * (import makeCase from "./spec.js")
 *
 * Or skip writing expectations and just try a message:  npm run eval -- --say "your message"
 */
export const EXTRA_CASES: Variation[] = [
  // Add your own cases here.
];
