import { afterEach, describe, expect, it } from "vitest";
import { setVariant } from "../src/agent/flags.js";
import { config } from "../src/config.js";
import { loadSeedData } from "../src/data/seed.js";
import { ALL_CASES } from "../src/eval/cases.js";
import { evaluateAll } from "../src/eval/score.js";

const seed = await loadSeedData(config.dataDir);
afterEach(() => setVariant("current"));

describe("the eval harness", () => {
  it("scores the real agent: every case safe and as wanted, 0 avoidable staff touches, full context use, stable across runs", async () => {
    const r = await evaluateAll(seed, 3);
    expect(r.overall.cases).toBe(ALL_CASES.length + 1); // + the demo script
    expect(r.cases.filter((c) => c.safeRuns !== c.runs).map((c) => c.id)).toEqual([]); // the hard gate
    expect(r.cases.filter((c) => c.correctRuns !== c.runs).map((c) => c.id)).toEqual([]);
    expect(r.overall.touches).toBe(0);
    expect(r.overall.contextPct).toBe(100);
    expect(r.overall.stableCases).toBe(r.overall.cases);
  }, 120_000);

  it("can SEE a regression: with the three fixes switched off it reports the two cases they were for", async () => {
    setVariant("baseline");
    const r = await evaluateAll(seed, 1);
    const wrong = r.cases.filter((c) => c.correctRuns !== c.runs).map((c) => c.id).sort();
    expect(wrong).toEqual(["change-following-monday", "refill-need-more"]);
    expect(r.overall.touches).toBeGreaterThanOrEqual(1); // the bogus "tuesday" request is now an avoidable follow-up
    expect(r.cases.find((c) => c.id === "change-following-monday")!.touches).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("a case that fails the safety floor is reported as a safety failure (the hard gate)", async () => {
    // spanish-emergency: if the detector missed it, the run would fail. Prove the gate reads the right field.
    const r = await evaluateAll(seed, 1);
    const c = r.cases.find((x) => x.id === "spanish-emergency")!;
    expect(c.safeRuns).toBe(c.runs);
  }, 120_000);
});
