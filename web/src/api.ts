import type { Handoff, HandoffStatus, ScriptStep, View } from "./types";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const detail = await res.json().then((j: { error?: string }) => j.error).catch(() => undefined);
    throw new Error(detail ?? `${method} ${url} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** The server couldn't finish handling Alex's message. `replyText` is what Alex must be shown; it is NOT in the thread. */
export class NotSaved extends Error {
  constructor(readonly replyText: string) {
    super("Not saved");
  }
}

async function sendMessage(body: string): Promise<unknown> {
  const res = await fetch("/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (res.status === 503) {
    const j = (await res.json().catch(() => ({}))) as { reply_text?: string };
    if (j.reply_text) throw new NotSaved(j.reply_text);
  }
  if (!res.ok) throw new Error(`POST /api/messages failed (${res.status})`);
  return res.json();
}

export const api = {
  view: () => call<View>("GET", "/api/thread"),
  /** Alex's message (simulated from the phone on file). */
  sendAsPatient: (body: string) => sendMessage(body),
  /** Clinic outbound message; `awaitingKind` says what a reply to it means. */
  sendAsClinic: (body: string, awaitingKind?: string) =>
    call<unknown>("POST", "/api/thread/clinic-messages", { body, ...(awaitingKind ? { awaiting_kind: awaitingKind } : {}) }),
  script: () => call<{ steps: ScriptStep[] }>("GET", "/api/demo/script").then((r) => r.steps),
  setClock: (local: string) => call<{ now: string }>("PUT", "/api/clock", { local }),
  resetClock: () => call<{ now: string }>("DELETE", "/api/clock"),
  resetDemo: () => call<View>("POST", "/api/demo/reset"),
  /** Turn AI assist on/off. Rejects with a readable message if no API key is configured. */
  setAiAssist: (on: boolean) => call<{ llm_available: boolean; llm_enabled: boolean; model: string | null }>("PUT", "/api/agent-mode", { llm: on }),
  setStatus: (id: string, status: HandoffStatus) => call<{ handoff: Handoff }>("PATCH", `/api/handoffs/${id}`, { status }),
};
