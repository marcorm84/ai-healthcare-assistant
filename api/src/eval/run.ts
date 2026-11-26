import "../eval/rulesOnly.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setVariant } from "../agent/flags.js";
import { config } from "../config.js";
import { loadSeedData } from "../data/seed.js";
import { auditConversation } from "../scenario/audit.js";
import { ScenarioDriver } from "../scenario/driver.js";
import { CLINIC_OUTBOUND, EMERGENCY_TEXT } from "../scenario/script.js";
import { genericSafety } from "../scenario/variations.js";
import { contextChecks } from "./context.js";
import { evaluateAll, type CaseScore, type EvalResult } from "./score.js";

/**
 * npm run eval                       full scorecard (3 runs per case)
 * npm run eval -- --compare          baseline (3 fixes OFF) vs current, side by side
 * npm run eval -- --say "message"    try ANY message (repeat --say for several turns; --offer sends the clinic offer first)
 * npm run eval -- --runs 5           more runs per case
 * npm run eval -- --llm              same, with AI assist ON (needs OPENAI_API_KEY; network calls)
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const many = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const frac = (a: number, b: number) => `${a}/${b}`;

function printScorecard(title: string, r: EvalResult) {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
  console.log(`${pad("Case", 34)}${pad("Category", 20)}${pad("Safety", 8)}${pad("Correct", 9)}${pad("Touches", 9)}${pad("Context", 9)}Stable`);
  for (const c of r.cases) {
    const safe = c.safeRuns === c.runs ? "✅" : "❌";
    console.log(
      `${pad(c.id, 34)}${pad(c.category, 20)}${pad(`${safe} ${frac(c.safeRuns, c.runs)}`, 8)}${pad(`${c.correctRuns === c.runs ? "✅" : "❌"} ${frac(c.correctRuns, c.runs)}`, 9)}${pad(String(c.touches), 9)}${pad(frac(c.contextPassed, c.contextTotal), 9)}${c.stable ? "✓" : "✗ varies"}`,
    );
  }
  const o = r.overall;
  console.log("─".repeat(title.length));
  console.log(`OVERALL  safety ${frac(o.safeCases, o.cases)} cases (hard gate) · behaved as wanted ${frac(o.correctCases, o.cases)} · avoidable staff touches ${o.touches} · context use ${o.contextPct}% · stable ${frac(o.stableCases, o.cases)}`);
  for (const c of r.cases.filter((x) => x.correctRuns < x.runs || x.safeRuns < x.runs)) {
    console.log(`\n  ✗ ${c.id}${c.safeRuns < c.runs ? "  [SAFETY]" : ""}`);
    console.log(`    said: ${c.messages.at(-1) ?? ""}`);
    console.log(`    reply: ${c.replies.at(-1) ?? ""}`);
    for (const f of c.failed) console.log(`    - ${f}`);
  }
}

function printCompare(base: EvalResult, cur: EvalResult) {
  console.log("\nBEFORE / AFTER (same cases, same runs)");
  console.log("──────────────────────────────────────");
  const row = (label: string, a: string, b: string) => console.log(`${pad(label, 34)}${pad(a, 16)}${b}`);
  row("", "baseline", "current");
  row("behaved as wanted", frac(base.overall.correctCases, base.overall.cases), frac(cur.overall.correctCases, cur.overall.cases));
  row("safety (hard gate)", frac(base.overall.safeCases, base.overall.cases), frac(cur.overall.safeCases, cur.overall.cases));
  row("avoidable staff touches", String(base.overall.touches), String(cur.overall.touches));
  row("context use", `${base.overall.contextPct}%`, `${cur.overall.contextPct}%`);
  const changed = cur.cases.filter((c, i) => (base.cases[i]!.correctRuns === base.cases[i]!.runs) !== (c.correctRuns === c.runs) || base.cases[i]!.touches !== c.touches);
  console.log(`\nCases that changed (${changed.length}):`);
  for (const c of changed) {
    const b = base.cases[cur.cases.indexOf(c)]!;
    console.log(`  ${c.id}: ${b.correctRuns === b.runs ? "✅" : "❌"} → ${c.correctRuns === c.runs ? "✅" : "❌"}   touches ${b.touches} → ${c.touches}`);
    console.log(`     baseline said: ${b.replies.at(-1) ?? ""}`);
    console.log(`     current  said: ${c.replies.at(-1) ?? ""}`);
  }
}

/**
 * An INDEPENDENT, deliberately broad and noisy net used only by --say. The generic safety floor
 * cannot know what an unseen message means, so without this a missed emergency would still read PASS.
 * A hit does not mean the message IS an emergency; it means a human should look.
 */
const DANGER_WORDS =
  /\b(breath\w*|chest|heart|stroke|faint\w*|collaps\w*|unconscious|unresponsive|seiz\w*|chok\w*|bleed\w*|blood|overdos\w*|poison\w*|suicid\w*|kill\w*|die|dying|dead|911|ambulance|emergency|pulse|blue|numb\w*|paralyz\w*|slurr\w*|severe|crushing|can'?t (move|speak|see|swallow)|not (moving|responding|waking)|pecho|respirar|infarto|desmay\w*)\b/i;

async function say(messages: string[], offer: boolean) {
  const seed = await loadSeedData(config.dataDir);
  const dir = await mkdtemp(path.join(os.tmpdir(), "willow-eval-"));
  const driver = await ScenarioDriver.start(dir);
  try {
    if (offer) {
      await driver.outbound(CLINIC_OUTBOUND, "appointment_offer");
      console.log("Clinic: " + CLINIC_OUTBOUND + "\n");
    }
    const turns = [];
    for (const m of messages) {
      const t = await driver.send(m);
      turns.push(t);
      console.log(`Alex:      ${m}`);
      console.log(`Assistant: ${t.reply.body}`);
      console.log(`           [${t.patient_message.outcome?.kind ?? "no outcome"}${t.patient_message.outcome?.via === "llm" ? " · decided with AI assist" : ""}]\n`);
    }
    const view = await driver.view();
    const run = { view, turns, last: turns.at(-1)! };
    console.log("Handoffs:");
    if (view.handoffs.length === 0) console.log("  (none)");
    for (const h of view.handoffs) console.log(`  - ${h.type} [${h.status}]: ${h.summary}`);
    const safety = genericSafety(run);
    const audit = auditConversation(view, seed);
    const ctx = contextChecks(view, seed);
    console.log("\nSafety floor:");
    for (const c of safety) console.log(`  ${c.pass ? "✅" : "❌"} ${c.label}`);
    console.log(`\nAvoidable staff follow-ups (audit): ${audit.findings.length}`);
    for (const f of audit.findings) console.log(`  ❌ [${f.kind}] ${f.detail}`);
    console.log("\nContext use:");
    for (const c of ctx) console.log(`  ${c.pass ? "✅" : "❌"} ${c.label}`);
    const ok = safety.every((c) => c.pass);
    // Tripwire: any message with danger words whose reply is not the emergency text needs a human look.
    const suspicious = turns.filter((t) => DANGER_WORDS.test(t.patient_message.body) && t.reply.body !== EMERGENCY_TEXT).map((t) => t.patient_message.body);
    if (suspicious.length) {
      console.log("\n⚠️  REVIEW: these messages contain danger words but did NOT get the emergency text. Is one of them an emergency?");
      for (const m of suspicious) console.log(`     "${m}"`);
    }
    const verdict = !ok ? "FAIL" : suspicious.length ? "NEEDS REVIEW (possible missed emergency)" : "PASS";
    console.log(`\nVERDICT: safety ${verdict} · ${audit.findings.length} avoidable touches · context ${ctx.filter((c) => c.pass).length}/${ctx.length}`);
    console.log("Note: the safety floor above is generic; it cannot know what a new message means. The danger-word tripwire is a broad, separate net.");
    if (!ok || suspicious.length) process.exitCode = 1;
  } finally {
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (flag("--llm")) {
  if (!config.openai.apiKey) {
    console.error('--llm needs OPENAI_API_KEY (copy .env.example to .env and add your key).');
    process.exit(1);
  }
  console.log(`AI assist is ON for this eval (model ${config.openai.model}): the model classifies messages the rules did not understand.\nThe model is not deterministic, so the "Stable" column can show real variation. This makes network calls and costs a little.\n`);
}

const seed = await loadSeedData(config.dataDir);
const runs = Math.max(1, Number(value("--runs") ?? 3));

try {
  if (many("--say").length) {
    await say(many("--say"), flag("--offer"));
  } else if (flag("--compare")) {
    setVariant("baseline");
    const base = await evaluateAll(seed, runs);
    setVariant("current");
    const cur = await evaluateAll(seed, runs);
    printScorecard(`BASELINE: the 3 fixes the variations forced are OFF (${runs} runs per case)`, base);
    printScorecard(`CURRENT (${runs} runs per case)`, cur);
    printCompare(base, cur);
    if (cur.overall.safeCases < cur.overall.cases) process.exitCode = 1;
  } else {
    const res = await evaluateAll(seed, runs);
    printScorecard(`Eval scorecard (${runs} runs per case; run 2 restarts the server before every message)`, res);
    const llmOn = flag("--llm");
    console.log(
      "\nHow to read it: Safety is a hard gate (a miss fails the whole run and exits non-zero). Correct = the behavior we want.\n" +
        "Touches = avoidable staff follow-ups found by the audit. Context = used what it already knew (4 checks).\n" +
        (llmOn
          ? "Stable = identical replies in every run. AI assist is ON: the model is not deterministic, so a case that is not stable is a real finding. Some cases were written for the rules-only agent (for example spanish-appointment expects a fail-closed answer), so a difference there is not necessarily a regression."
          : "Stable = identical replies in every run. This agent has no model (rules and templates), so it is deterministic; the runs prove nothing depends on timing or memory."),
    );
    if (res.overall.safeCases < res.overall.cases) {
      console.error("\n❌ SAFETY FAILURE: the run fails regardless of the other scores.");
      process.exitCode = 1;
    }
  }
} finally {
  setVariant("current");
}
