import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findReplyViolations, PROCESSING_FAILED_REPLY } from "../src/agent/safety.js";
import { createApp } from "../src/app.js";
import { createContext } from "../src/context.js";

// Written out literally, not imported.
const EMERGENCY =
  "If you think you are having a medical emergency, call 911 or go to the nearest emergency room now. This text line is not monitored continuously and cannot help in an emergency.";

async function setup() {
  const ctx = await createContext({ storeDir: await mkdtemp(path.join(os.tmpdir(), "willow-")) });
  const app = createApp(ctx);
  const say = (body: string) => request(app).post("/api/messages").send({ body });
  const thread = async () => (await request(app).get("/api/thread")).body;
  return { ctx, app, say, thread };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("never claim a request was saved when saving failed", () => {
  it.each([
    ["a refill", "can I get a refill on my BP med"],
    ["an appointment request", "I need my blood pressure rechecked. Tuesday works."],
    ["a clinical question", "my readings have been around 150/95 all week, should I take two pills?"],
    ["a billing question", "I think this charge is wrong, I shouldn't owe $40"],
  ])("handoff can't be saved: %s", async (_label, text) => {
    const { ctx, say, thread } = await setup();
    vi.spyOn(ctx.repos.handoffs, "create").mockRejectedValue(new Error("disk full"));
    const res = await say(text);

    expect(res.status).toBe(503);
    expect(res.body.reply_text).toBe(PROCESSING_FAILED_REPLY);
    expect(res.body.reply_text).not.toMatch(/submitted|sent|passed|pending|booked|saved/i); // claims nothing
    expect(findReplyViolations(res.body.reply_text)).toEqual([]);

    const t = await thread();
    expect(t.handoffs).toEqual([]); // nothing was stored
    expect(t.messages.map((m: { sender: string }) => m.sender)).toEqual(["patient"]); // no assistant message either
  });

  it("the whole store is down: still no claim, and the next message works once it is back", async () => {
    const { ctx, say } = await setup();
    const spy = vi.spyOn(ctx.store, "update").mockRejectedValue(new Error("EIO"));
    const res = await say("can I get a refill on my BP med");
    expect(res.status).toBe(503);
    expect(res.body.reply_text).toBe(PROCESSING_FAILED_REPLY);
    spy.mockRestore();
    expect((await say("what time do you close today?")).status).toBe(201);
  });

  it("a failed update to an existing request does not claim the change", async () => {
    const { ctx, say } = await setup();
    await say("I need my blood pressure rechecked. Tuesday afternoon works.");
    vi.spyOn(ctx.repos.handoffs, "update").mockRejectedValue(new Error("disk full"));
    const res = await say("actually can we do Thursday instead");
    expect(res.status).toBe(503);
    expect(res.body.reply_text).toBe(PROCESSING_FAILED_REPLY);
    expect(ctx.repos.handoffs.list()[0]!.details.requested_date).toBe("2026-11-10"); // unchanged on disk and in memory
  });
});

describe("the emergency text never depends on storage", () => {
  it.each([
    ["the message can't be stored", (ctx: Awaited<ReturnType<typeof setup>>["ctx"]) => vi.spyOn(ctx.repos.messages, "append").mockRejectedValue(new Error("disk full"))],
    ["the whole store is down", (ctx: Awaited<ReturnType<typeof setup>>["ctx"]) => vi.spyOn(ctx.store, "update").mockRejectedValue(new Error("EIO"))],
    ["the thread can't be read or created", (ctx: Awaited<ReturnType<typeof setup>>["ctx"]) => vi.spyOn(ctx.repos.threads, "getOrCreate").mockRejectedValue(new Error("EIO"))],
  ])("%s: Alex still gets the exact text, and nothing else", async (_label, breakIt) => {
    const { ctx, say } = await setup();
    breakIt(ctx);
    const res = await say("I have chest pain and my left arm feels numb");
    expect(res.status).toBe(503); // not saved...
    expect(res.body.reply_text).toBe(EMERGENCY); // ...but the safety text is exact
    expect(res.body.reply_text).not.toBe(PROCESSING_FAILED_REPLY);
  });

  it("when only the handoff can't be saved it is a normal 201 with the exact text (the outcome says no handoff)", async () => {
    const { ctx, say } = await setup();
    vi.spyOn(ctx.repos.handoffs, "create").mockRejectedValue(new Error("disk full"));
    const res = await say("I can't breathe");
    expect(res.status).toBe(201);
    expect(res.body.reply.body).toBe(EMERGENCY);
    expect(res.body.patient_message.outcome).toEqual({ kind: "emergency" }); // no handoff_id: the UI must not say "logged"
  });

  it("a non-emergency never gets the emergency text as a failure message", async () => {
    const { ctx, say } = await setup();
    vi.spyOn(ctx.store, "update").mockRejectedValue(new Error("EIO"));
    expect((await say("what time do you close today?")).body.reply_text).toBe(PROCESSING_FAILED_REPLY);
  });
});
