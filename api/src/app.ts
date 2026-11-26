import cors from "cors";
import express from "express";
import { z } from "zod";
import { createRuleAgent } from "./agent/ruleAgent.js";
import type { Agent } from "./agent/types.js";
import type { AppContext } from "./context.js";
import { ConversationService } from "./conversation.js";
import { config } from "./config.js";
import { HANDOFF_STATUSES } from "./domain/schemas.js";
import { HandoffError } from "./handoffs/service.js";
import { STEPS } from "./scenario/script.js";
import { clinicLocalToIso } from "./time.js";

const MessageBody = z.object({ body: z.string().trim().min(1).max(2000) });
const ClinicMessageBody = MessageBody.extend({ awaiting_kind: z.string().min(1).optional() });

export function createApp(ctx: AppContext, agent: Agent = createRuleAgent(ctx)) {
  const conversation = new ConversationService(ctx, agent);
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // The patient's thread: messages, handoffs and the scenario clock.
  app.get("/api/thread", async (_req, res) => {
    res.json(await conversation.getThreadView());
  });

  // Clinic outbound message (e.g. scenario step 0). Saved locally; nothing is sent.
  app.post("/api/thread/clinic-messages", async (req, res) => {
    const body = ClinicMessageBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "body (1-2000 chars) is required" });
    res.status(201).json(await conversation.sendClinicMessage(body.data.body, body.data.awaiting_kind));
  });

  // Inbound patient message, simulated as coming from the phone on file.
  app.post("/api/messages", async (req, res) => {
    const body = MessageBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "body (1-2000 chars) is required" });
    const result = await conversation.receivePatientMessage(body.data.body);
    // 503 = not fully handled. `reply_text` is what Alex must be shown; nothing is claimed as saved.
    if ("failed" in result) return void res.status(503).json({ error: "not_saved", reply_text: result.reply_text });
    res.status(201).json(result);
  });

  // Scenario clock: view, change (live demo), reset to Wed Nov 4, 2026 10:00 PT.
  app.get("/api/clock", (_req, res) => {
    res.json({ now: ctx.clock.now() });
  });

  // Either an exact instant ({now}) or clinic wall-clock time ({local: "2026-11-07T10:00"}, Pacific).
  app.put("/api/clock", async (req, res) => {
    const body = z.object({ now: z.string().optional(), local: z.string().optional() }).safeParse(req.body);
    const iso = body.success ? (body.data.local ? clinicLocalToIso(body.data.local) : body.data.now) : undefined;
    if (!iso) return void res.status(400).json({ error: "now (ISO-8601 with offset) or local (YYYY-MM-DDTHH:mm) is required" });
    try {
      res.json({ now: await ctx.clock.set(iso) });
    } catch {
      res.status(400).json({ error: "not a valid date/time" });
    }
  });

  app.delete("/api/clock", async (_req, res) => {
    res.json({ now: await ctx.clock.reset() });
  });

  // AI assist switch. Only enabled when OPENAI_API_KEY is configured; off by default.
  app.get("/api/agent-mode", (_req, res) => {
    res.json(ctx.llm.status());
  });

  app.put("/api/agent-mode", async (req, res) => {
    const body = z.object({ llm: z.boolean() }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "llm (boolean) is required" });
    try {
      await ctx.llm.setEnabled(body.data.llm);
    } catch {
      return void res.status(409).json({ error: "no_api_key", message: "AI assist needs OPENAI_API_KEY in .env (see .env.example), then restart the API." });
    }
    res.json(ctx.llm.status());
  });

  // ---- Demo helpers (local demo only) ----

  // The demo script, so the UI can offer each step as a button.
  app.get("/api/demo/script", (_req, res) => {
    res.json({ steps: STEPS });
  });

  // Wipe the conversation and handoffs and put the clock back to the scenario time.
  app.post("/api/demo/reset", async (_req, res) => {
    await ctx.store.update((s) => {
      s.threads = [];
      s.messages = [];
      s.handoffs = [];
      s.settings.now = config.defaultNow;
    });
    res.json(await conversation.getThreadView());
  });

  // Simulated clinic staff: record a decision on a request. The agent never calls this.
  app.patch("/api/handoffs/:id", async (req, res) => {
    const body = z.object({ status: z.enum(HANDOFF_STATUSES) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: `status must be one of ${HANDOFF_STATUSES.join(", ")}` });
    try {
      const handoff = await ctx.handoffs.setStatus(String(req.params.id), body.data.status);
      res.json({ handoff: { ...handoff, summary: ctx.handoffs.summarize(handoff) } });
    } catch (err) {
      if (err instanceof HandoffError && err.code === "not_found") return void res.status(404).json({ error: err.message });
      if (err instanceof HandoffError && err.code === "invalid_transition") return void res.status(409).json({ error: err.message });
      throw err;
    }
  });

  // Express 5 forwards async errors here; failures stay JSON, never a hung request.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
