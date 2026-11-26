import { useCallback, useEffect, useState } from "react";
import { api, NotSaved } from "./api";
import { Chat } from "./components/Chat";
import { AiToggle } from "./components/AiToggle";
import { ClockBar } from "./components/ClockBar";
import { HandoffPanel } from "./components/HandoffPanel";
import { ScriptPanel } from "./components/ScriptPanel";
import type { HandoffStatus, ScriptStep, View } from "./types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App() {
  const [view, setView] = useState<View | null>(null);
  const [steps, setSteps] = useState<ScriptStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  /** A reply Alex must see although the server could not save it. Shown apart, never mixed into the thread. */
  const [unsaved, setUnsaved] = useState<string | null>(null);

  const refresh = useCallback(async () => setView(await api.view()), []);

  // State lives on the server, so a reload (or a server restart) picks the conversation up where it was.
  useEffect(() => {
    refresh().catch((e) => setError(`Can't reach the API: ${message(e)}`));
    api.script().then(setSteps).catch(() => undefined);
  }, [refresh]);

  /** Run an action, then show the server's resulting state. Errors are shown, never swallowed. */
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      setUnsaved(null);
      try {
        await action();
        await refresh();
      } catch (e) {
        if (e instanceof NotSaved) setUnsaved(e.replyText);
        else setError(message(e));
        await refresh().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const send = (role: "patient" | "clinic", text: string) =>
    run(() => (role === "patient" ? api.sendAsPatient(text) : api.sendAsClinic(text)));

  const runStep = (step: ScriptStep) =>
    run(() => (step.n === 0 ? api.sendAsClinic(step.input, "appointment_offer") : api.sendAsPatient(step.input)));

  const reset = () => {
    if (window.confirm("Reset the demo? This clears the conversation and all handoffs, and resets the clock.")) {
      void run(() => api.resetDemo());
    }
  };

  if (!view) {
    return <main className="shell">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>;
  }

  return (
    <main className="shell">
      <div className="card-frame">
        <header className="top">
          <h1>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#2e7d32" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z" />
              <path d="M2 21c0-3 1.9-5.2 4-6.5 2-1.2 4-2 6-2.5" />
            </svg>
            Willow Family Clinic
          </h1>
          <AiToggle agent={view.agent} busy={busy} onToggle={(on) => run(() => api.setAiAssist(on))} />
          <span className="badge">Local demo</span>
          <button className="btn small ghost" onClick={reset} disabled={busy}>Reset demo</button>
        </header>

        <ClockBar now={view.now} busy={busy} onSet={(local) => run(() => api.setClock(local))} />
        {error && <p className="error" role="alert">{error}</p>}

        <div className="grid">
          <div className="left">
            <Chat view={view} busy={busy} highlight={highlight} unsaved={unsaved} onSend={send} onFocusHandoff={setFocused} />
            <ScriptPanel steps={steps} messages={view.messages} busy={busy} onRun={runStep} />
          </div>
          <HandoffPanel
            handoffs={view.handoffs}
            messages={view.messages}
            busy={busy}
            focusedId={focused}
            onHover={setHighlight}
            onStatus={(id: string, status: HandoffStatus) => run(() => api.setStatus(id, status))}
          />
        </div>
      </div>
    </main>
  );
}
