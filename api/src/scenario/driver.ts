import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";
import { createContext } from "../context.js";
import type { Handoff, Message, Thread } from "../domain/schemas.js";

export interface Turn {
  patient_message: Message;
  reply: Message;
  thread: Thread;
}

export interface View {
  thread: Thread;
  messages: Message[];
  handoffs: (Handoff & { summary: string })[];
  now: string;
}

/**
 * Drives the real HTTP API of an in-process server (random port, own store dir).
 * `restart()` throws the whole process state away and boots again from the files,
 * which is exactly what a user does when they stop and restart the demo.
 */
export class ScenarioDriver {
  private server!: http.Server;
  private base = "";

  private constructor(readonly storeDir: string) {}

  static async start(storeDir: string): Promise<ScenarioDriver> {
    const d = new ScenarioDriver(storeDir);
    await d.boot();
    return d;
  }

  private async boot() {
    const app = createApp(await createContext({ storeDir: this.storeDir }));
    this.server = http.createServer(app);
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async restart() {
    await this.close();
    await this.boot();
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + url, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  outbound(body: string, awaitingKind?: string) {
    return this.call<{ message: Message; thread: Thread }>("POST", "/api/thread/clinic-messages", {
      body,
      ...(awaitingKind ? { awaiting_kind: awaitingKind } : {}),
    });
  }
  send(body: string) {
    return this.call<Turn>("POST", "/api/messages", { body });
  }
  view() {
    return this.call<View>("GET", "/api/thread");
  }
  setClock(now: string) {
    return this.call<{ now: string }>("PUT", "/api/clock", { now });
  }
}
