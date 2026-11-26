import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScenarioDriver } from "../src/scenario/driver.js";
import { EMERGENCY_TEXT, runScript, STEPS, type ScriptResult } from "../src/scenario/checks.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "willow-scenario-"));
const failures = (checks: { label: string; pass: boolean }[]) => checks.filter((c) => !c.pass).map((c) => c.label);

describe("Demo script, steps 0-11, one conversation (restart before step 6)", () => {
  let driver: ScenarioDriver;
  let dir: string;
  let result: ScriptResult;

  beforeAll(async () => {
    dir = await tmp();
    driver = await ScenarioDriver.start(dir);
    result = await runScript(driver, {
      before: async (n) => {
        if (n === 6) await driver.restart();
      },
    });
  });
  afterAll(async () => {
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  });

  for (const step of STEPS) {
    it(`step ${step.n}: ${step.input.slice(0, 60)}`, () => {
      expect(failures(result.steps[step.n]!.checks)).toEqual([]);
    });
  }

  it("whole-conversation checks (handoffs, links, safety, persistence)", () => {
    expect(failures(result.invariants)).toEqual([]);
  });
});

describe("persistence: the process restarts before EVERY step", () => {
  it("still passes every check", async () => {
    const dir = await tmp();
    const driver = await ScenarioDriver.start(dir);
    try {
      const r = await runScript(driver, { before: () => driver.restart() });
      expect(r.steps.flatMap((s) => failures(s.checks))).toEqual([]);
      expect(failures(r.invariants)).toEqual([]);
    } finally {
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("live variations on the same script", () => {
  it("the scenario clock is a setting: change it and the same questions get different, correct answers", async () => {
    const dir = await tmp();
    const driver = await ScenarioDriver.start(dir);
    try {
      expect((await driver.send("what time do you close today?")).reply.body).toBe("We close at 5:00 p.m. Pacific today (Wednesday).");
      await driver.setClock("2026-11-07T10:00:00-08:00"); // Saturday
      expect((await driver.send("what time do you close today?")).reply.body).toBe(
        "We're closed today (it's a weekend). We reopen on Monday, November 9 at 9:00 a.m. Pacific.",
      );
      await driver.restart(); // the clock survives a restart
      expect((await driver.view()).now).toBe("2026-11-07T10:00:00-08:00");
    } finally {
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the emergency rule works at any point of the conversation, and the thread carries on afterwards", async () => {
    const dir = await tmp();
    const driver = await ScenarioDriver.start(dir);
    try {
      await driver.send("I need my blood pressure rechecked. Tuesday works.");
      expect((await driver.send("I have chest pain and my left arm feels numb")).reply.body).toBe(EMERGENCY_TEXT);
      const after = await driver.send("actually can we do Thursday instead");
      expect(after.reply.body).toContain("I've updated your BP recheck request to Thursday, November 12");
      const view = await driver.view();
      expect(view.handoffs.map((h) => h.type).sort()).toEqual(["appointment_request", "emergency"]);
    } finally {
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
