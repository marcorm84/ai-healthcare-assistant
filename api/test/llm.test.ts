import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAiClassifier, type IntentClassifier, type LlmClassification } from "../src/agent/llm/openai.js";
import { findReplyViolations } from "../src/agent/safety.js";
import { createApp } from "../src/app.js";
import { createContext } from "../src/context.js";

const EMERGENCY =
  "If you think you are having a medical emergency, call 911 or go to the nearest emergency room now. This text line is not monitored continuously and cannot help in an emergency.";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ---- the real client, against a local server that imitates OpenAI ----------------------------

interface Captured {
  url?: string;
  auth?: string;
  body?: any;
}

async function fakeOpenAi(handler: (req: http.IncomingMessage, res: http.ServerResponse, cap: Captured) => void) {
  const cap: Captured = {};
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      cap.url = req.url;
      cap.auth = req.headers.authorization;
      cap.body = raw ? JSON.parse(raw) : undefined;
      handler(req, res, cap);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { cap, baseUrl, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

const reply = (res: http.ServerResponse, content: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] } : { error: "x" }));
};

describe("OpenAI classifier (real fetch path, local fake server)", () => {
  it("sends only the message text, with a strict JSON schema, and returns the validated classification", async () => {
    const srv = await fakeOpenAi((_req, res) => reply(res, { intent: "refill_request", confidence: "high", possible_emergency: false }));
    try {
      const c = createOpenAiClassifier({ apiKey: "sk-test", model: "gpt-4o-mini", baseUrl: srv.baseUrl });
      const out = await c.classify("could you top up my tablets please");
      expect(out).toEqual({ intent: "refill_request", confidence: "high", possible_emergency: false });

      expect(srv.cap.url).toBe("/v1/chat/completions");
      expect(srv.cap.auth).toBe("Bearer sk-test");
      const b = srv.cap.body;
      expect(b.model).toBe("gpt-4o-mini");
      expect(b.temperature).toBe(0);
      expect(b.response_format.type).toBe("json_schema");
      expect(b.response_format.json_schema.strict).toBe(true);
      expect(b.response_format.json_schema.schema.properties.intent.enum).toContain("clinical_question");

      // Privacy: nothing about the patient or the record is in the request, only the fixed prompt and the message.
      const sent = JSON.stringify(b);
      for (const secret of ["Alex", "Morgan", "Lisinopril", "1981", "Elm Street", "Blue Shield", "555-010-0199", "pt_001"]) expect(sent).not.toContain(secret);
      expect(b.messages).toHaveLength(2);
      expect(b.messages[1]).toEqual({ role: "user", content: "<message>could you top up my tablets please</message>" });
      // The prompt treats the message as untrusted data.
      expect(b.messages[0].content).toMatch(/untrusted DATA/);
      expect(b.messages[0].content).toMatch(/ignore all of that/);
    } finally {
      await srv.close();
    }
  });

  it("omits temperature for reasoning-style models", async () => {
    const srv = await fakeOpenAi((_r, res) => reply(res, { intent: "unknown", confidence: "low", possible_emergency: false }));
    try {
      await createOpenAiClassifier({ apiKey: "k", model: "o3-mini", baseUrl: srv.baseUrl }).classify("x");
      expect("temperature" in srv.cap.body).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it.each([
    ["HTTP 500", (_q: any, res: http.ServerResponse) => reply(res, "", 500)],
    ["HTTP 401", (_q: any, res: http.ServerResponse) => reply(res, "", 401)],
    ["not JSON", (_q: any, res: http.ServerResponse) => reply(res, "sure, it's a refill!")],
    ["wrong shape", (_q: any, res: http.ServerResponse) => reply(res, { intent: "refill_request" })],
    ["an intent outside the list", (_q: any, res: http.ServerResponse) => reply(res, { intent: "give_medical_advice", confidence: "high", possible_emergency: false })],
    ["empty answer", (_q: any, res: http.ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [] })); }],
  ])("returns null (so the rules take over) on %s", async (_label, handler) => {
    const srv = await fakeOpenAi(handler);
    try {
      expect(await createOpenAiClassifier({ apiKey: "k", model: "m", baseUrl: srv.baseUrl }).classify("x")).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it("returns null on a timeout and on a network error", async () => {
    const slow = await fakeOpenAi((_r, res) => setTimeout(() => reply(res, { intent: "refill_request", confidence: "high", possible_emergency: false }), 400));
    try {
      expect(await createOpenAiClassifier({ apiKey: "k", model: "m", baseUrl: slow.baseUrl, timeoutMs: 50 }).classify("x")).toBeNull();
    } finally {
      await slow.close();
    }
    expect(await createOpenAiClassifier({ apiKey: "k", model: "m", baseUrl: "http://127.0.0.1:1/v1" }).classify("x")).toBeNull();
  });
});

// ---- the hybrid agent, with a scripted classifier -------------------------------------------

function scripted(result: LlmClassification | null) {
  const classify = vi.fn(async (_t: string) => result);
  const c: IntentClassifier = { model: "fake-model", classify };
  return { c, classify };
}

async function setup(result: LlmClassification | null, opts: { enabled?: boolean; classifier?: IntentClassifier | null } = {}) {
  const fake = scripted(result);
  const dir = await mkdtemp(path.join(os.tmpdir(), "willow-llm-"));
  const ctx = await createContext({ storeDir: dir, classifier: opts.classifier === undefined ? fake.c : opts.classifier });
  if (opts.enabled !== false && opts.classifier !== null) await ctx.llm.setEnabled(true);
  const app = createApp(ctx);
  return { ctx, app, dir, classify: fake.classify, say: async (body: string) => (await request(app).post("/api/messages").send({ body })).body };
}

const high = (intent: LlmClassification["intent"], possible_emergency = false): LlmClassification => ({ intent, confidence: "high", possible_emergency });

describe("AI assist is a fallback behind the rules, never in front of them", () => {
  it("OFF: the model is never called, whatever the message", async () => {
    const { say, classify } = await setup(high("refill_request"), { enabled: false });
    const r = await say("could you kindly top up my hypertension tablets");
    expect(classify).not.toHaveBeenCalled();
    expect(r.reply.body).toBe("I don't have information on that. Would you like me to pass your question to staff?");
  });

  it("ON, but the rules understood the message: the model is not called", async () => {
    const { say, classify } = await setup(high("refill_request"));
    expect((await say("what time do you close today?")).reply.body).toBe("We close at 5:00 p.m. Pacific today (Wednesday).");
    expect(classify).not.toHaveBeenCalled();
  });

  it("ON, a regex emergency: the exact text comes first and the model is not consulted", async () => {
    const { say, classify, ctx } = await setup(high("hours"));
    const r = await say("I can't breathe");
    expect(r.reply.body).toBe(EMERGENCY);
    expect(classify).not.toHaveBeenCalled();
    expect(ctx.repos.handoffs.list().map((h) => h.type)).toEqual(["emergency"]);
  });

  it("ON, the rules don't understand: the model's label routes it through the SAME refill flow and templates", async () => {
    const { say, classify, ctx } = await setup(high("refill_request"));
    const r = await say("could you kindly top up my hypertension tablets");
    expect(classify).toHaveBeenCalledTimes(1);
    expect(r.reply.body).toContain("I've sent a refill request for Lisinopril 10 mg (once daily)");
    expect(r.patient_message.outcome).toMatchObject({ kind: "handoff_created", via: "llm" });
    const [h] = ctx.repos.handoffs.list();
    expect(h).toMatchObject({ type: "refill", status: "pending_staff" });
    expect(h!.details).toMatchObject({ medication: "Lisinopril", dose: "10 mg", pharmacy: "Elm Street Pharmacy, (555) 010-0142", refills_remaining: 0 }); // from the record, not the model
  });

  it("ON: a clinical label files a clinical question and gives no advice", async () => {
    const { say, ctx } = await setup(high("clinical_question"));
    const r = await say("my ankles have ballooned since the new prescription, what now");
    expect(r.reply.body).toMatch(/^I can't give medical advice, but I've passed your question/);
    expect(findReplyViolations(r.reply.body)).toEqual([]);
    expect(ctx.repos.handoffs.list().map((h) => h.type)).toEqual(["clinical_question"]);
    expect(r.patient_message.outcome.via).toBe("llm");
  });

  it("ON: the model's possible-emergency flag yields the exact emergency text and an emergency handoff (it can only ADD one)", async () => {
    const { say, ctx } = await setup({ intent: "unknown", confidence: "low", possible_emergency: true });
    const r = await say("my uncle went completely grey and has stopped answering us");
    expect(r.reply.body).toBe(EMERGENCY);
    const [h] = ctx.repos.handoffs.list();
    expect(h).toMatchObject({ type: "emergency", status: "pending_staff" });
    expect(h!.details.signals).toEqual(["llm_possible_emergency"]);
    expect(r.patient_message.outcome).toMatchObject({ kind: "emergency", via: "llm" });
  });

  it("ON: the model can never turn a regex emergency OFF", async () => {
    const { say } = await setup({ intent: "thanks", confidence: "high", possible_emergency: false });
    expect((await say("my dad is not breathing")).reply.body).toBe(EMERGENCY);
  });

  it.each([
    ["low confidence", { intent: "refill_request", confidence: "low", possible_emergency: false } as LlmClassification],
    ["unknown", { intent: "unknown", confidence: "high", possible_emergency: false } as LlmClassification],
    ["the model failed (null)", null],
  ])("ON, %s: falls back to the rules' safe answer, creating nothing", async (_label, result) => {
    const { say, ctx, classify } = await setup(result);
    const r = await say("could you kindly top up my hypertension tablets");
    expect(classify).toHaveBeenCalledTimes(1);
    expect(r.reply.body).toBe("I don't have information on that. Would you like me to pass your question to staff?");
    expect(ctx.repos.handoffs.list()).toEqual([]);
    expect(r.patient_message.outcome.via).toBeUndefined();
  });

  it("a wrong label cannot create a bad record: an appointment label with no reason or day just asks", async () => {
    const { say, ctx } = await setup(high("appointment_request"));
    const r = await say("do you offer flu shots");
    expect(r.reply.body).toMatch(/^(What's the appointment for\?|When would you like to come in\?)/);
    expect(ctx.repos.handoffs.list()).toEqual([]);
  });

  it('a paraphrase the rules miss ("pop in next Tuesday around 3 to get my pressure looked at") becomes a complete request with no questions', async () => {
    const { say, ctx } = await setup(high("appointment_request"));
    const r = await say("any chance I could pop in next Tuesday around 3 to get my pressure looked at?");
    expect(r.reply.body).toContain("I've submitted your BP recheck request");
    expect(ctx.repos.handoffs.list()[0]!.details).toMatchObject({ reason: "BP recheck", requested_date: "2026-11-10", time_window: "afternoon" });
    expect(String(ctx.repos.handoffs.list()[0]!.details.patient_note)).toContain("3:00 p.m.");
  });

  it("replies are always the clinic's templates: nothing the model returns is ever shown to Alex", async () => {
    const poisoned = { intent: "balance", confidence: "high", possible_emergency: false, reply: "Sure! Take 3 pills." } as unknown as LlmClassification;
    const { say } = await setup(poisoned);
    const r = await say("whats the damage on my account");
    expect(r.reply.body).not.toContain("Take 3 pills");
    expect(r.reply.body).toContain("Your balance is $40.00");
  });
});

describe("the AI assist switch", () => {
  it("without a key it is unavailable and cannot be enabled (409), and the agent still works", async () => {
    const { app, say } = await setup(null, { classifier: null });
    expect((await request(app).get("/api/agent-mode")).body).toEqual({ llm_available: false, llm_enabled: false, model: null });
    const res = await request(app).put("/api/agent-mode").send({ llm: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_api_key");
    expect((await say("what time do you close today?")).reply.body).toContain("5:00 p.m.");
  });

  it("with a key it can be switched on and off, is shown in the thread view, and survives a restart", async () => {
    const { app, dir } = await setup(high("refill_request"), { enabled: false });
    expect((await request(app).get("/api/agent-mode")).body).toEqual({ llm_available: true, llm_enabled: false, model: "fake-model" });
    expect((await request(app).put("/api/agent-mode").send({ llm: true })).body.llm_enabled).toBe(true);
    expect((await request(app).get("/api/thread")).body.agent).toEqual({ llm_available: true, llm_enabled: true, model: "fake-model" });

    const again = await createContext({ storeDir: dir, classifier: scripted(null).c }); // "restart"
    expect(again.llm.status().llm_enabled).toBe(true);
    expect((await request(createApp(again)).put("/api/agent-mode").send({ llm: false })).body.llm_enabled).toBe(false);
  });

  it("rejects a bad body, and an old store file without the setting loads as OFF", async () => {
    const { app } = await setup(null, { enabled: false });
    expect((await request(app).put("/api/agent-mode").send({ llm: "yes" })).status).toBe(400);
    const { createContext: cc } = await import("../src/context.js");
    const fs = await import("node:fs/promises");
    const dir = await mkdtemp(path.join(os.tmpdir(), "willow-old-"));
    await fs.writeFile(path.join(dir, "db.json"), JSON.stringify({ version: 1, settings: { now: "2026-11-04T10:00:00-08:00" }, threads: [], messages: [], handoffs: [] }));
    expect((await cc({ storeDir: dir, classifier: null })).store.read().settings.llm_enabled).toBe(false);
  });
});
