import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SeedData } from "../data/seed.js";
import { auditConversation } from "../scenario/audit.js";
import { ScenarioDriver } from "../scenario/driver.js";
import { runScript, type Check } from "../scenario/checks.js";
import { runVariation, type Variation } from "../scenario/variations.js";
import { ALL_CASES } from "./cases.js";
import { contextChecks } from "./context.js";

/**
 * Scoring. Each case is run `runs` times:
 *   run 1: plain, fresh store          run 2: the server is RESTARTED before every message
 *   run 3+: plain, fresh store
 * The agent is deterministic (rules and templates, no model), so identical results are expected; the
 * runs prove that nothing depends on timing, process memory or leftover state, and `stable` flags it if so.
 */
export interface CaseScore {
  id: string;
  category: string;
  title: string;
  runs: number;
  /** Runs that met the safety floor (a HARD gate: any miss fails the whole eval). */
  safeRuns: number;
  /** Runs that behaved as wanted. */
  correctRuns: number;
  /** Avoidable staff follow-ups found by the audit (worst run). */
  touches: number;
  contextPassed: number;
  contextTotal: number;
  /** Same replies in every run. */
  stable: boolean;
  failed: string[];
  messages: string[];
  replies: string[];
}

export interface Overall {
  cases: number;
  safeCases: number;
  correctCases: number;
  touches: number;
  contextPct: number;
  stableCases: number;
}

export interface EvalResult {
  cases: CaseScore[];
  overall: Overall;
}

const tmp = () => mkdtemp(path.join(os.tmpdir(), "willow-eval-"));

function summarize(runsData: { safe: boolean; correct: boolean; touches: number; ctx: Check[]; replies: string[]; failed: string[] }[], meta: Pick<CaseScore, "id" | "category" | "title" | "messages">): CaseScore {
  const first = runsData[0]!;
  const ctxWorst = runsData.reduce((w, r) => (r.ctx.filter((c) => c.pass).length < w.ctx.filter((c) => c.pass).length ? r : w), first);
  return {
    ...meta,
    runs: runsData.length,
    safeRuns: runsData.filter((r) => r.safe).length,
    correctRuns: runsData.filter((r) => r.correct).length,
    touches: Math.max(...runsData.map((r) => r.touches)),
    contextPassed: ctxWorst.ctx.filter((c) => c.pass).length,
    contextTotal: ctxWorst.ctx.length,
    stable: runsData.every((r) => r.replies.join("\n") === first.replies.join("\n")),
    failed: runsData.find((r) => !r.correct || !r.safe)?.failed ?? [],
    replies: first.replies,
  };
}

export async function evaluateCase(v: Variation, seed: SeedData, runs: number): Promise<CaseScore> {
  const data = [];
  for (let i = 0; i < runs; i++) {
    const r = await runVariation(v, { restartEachTurn: i === 1 });
    data.push({
      safe: r.safeFailure,
      correct: r.correct,
      touches: auditConversation(r.view, seed).findings.length,
      ctx: contextChecks(r.view, seed),
      replies: r.replies,
      failed: [...r.must, ...r.safe].filter((c) => !c.pass).map((c) => c.label),
    });
  }
  return summarize(data, { id: v.id, category: v.category, title: v.title, messages: v.messages });
}

/** The 12-step demo script as one case. */
export async function evaluateScript(seed: SeedData, runs: number): Promise<CaseScore> {
  const data = [];
  for (let i = 0; i < runs; i++) {
    const dir = await tmp();
    const driver = await ScenarioDriver.start(dir);
    try {
      const res = await runScript(driver, { before: i === 1 ? () => driver.restart() : undefined });
      const all: Check[] = [...res.steps.flatMap((s) => s.checks), ...res.invariants];
      const safeChecks = all.filter((c) => c.label.startsWith("SAFETY"));
      data.push({
        safe: safeChecks.every((c) => c.pass),
        correct: all.every((c) => c.pass),
        touches: auditConversation(res.final, seed).findings.length,
        ctx: contextChecks(res.final, seed),
        replies: res.steps.map((s) => s.reply ?? ""),
        failed: all.filter((c) => !c.pass).map((c) => c.label),
      });
    } finally {
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
  return summarize(data, { id: "demo-script (steps 0-11)", category: "script", title: "the 12-step demo script", messages: [] });
}

export async function evaluateAll(seed: SeedData, runs: number): Promise<EvalResult> {
  const cases = [await evaluateScript(seed, runs)];
  for (const v of ALL_CASES) cases.push(await evaluateCase(v, seed, runs));
  const ctxTotal = cases.reduce((n, c) => n + c.contextTotal, 0);
  const ctxPassed = cases.reduce((n, c) => n + c.contextPassed, 0);
  return {
    cases,
    overall: {
      cases: cases.length,
      safeCases: cases.filter((c) => c.safeRuns === c.runs).length,
      correctCases: cases.filter((c) => c.correctRuns === c.runs).length,
      touches: cases.reduce((n, c) => n + c.touches, 0),
      contextPct: ctxTotal ? Math.round((100 * ctxPassed) / ctxTotal) : 100,
      stableCases: cases.filter((c) => c.stable).length,
    },
  };
}
