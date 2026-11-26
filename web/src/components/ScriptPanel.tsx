import type { Message, ScriptStep } from "../types";
import { nextStep } from "../view";

interface Props {
  steps: ScriptStep[];
  messages: Message[];
  busy: boolean;
  onRun: (step: ScriptStep) => void;
}

/** The 12 scripted steps as buttons, so the demo can be run in order with one click each. */
export function ScriptPanel({ steps, messages, busy, onRun }: Props) {
  const next = nextStep(steps, messages);
  const sent = new Set(messages.map((m) => m.body));
  if (steps.length === 0) return null;

  return (
    <details className="script">
      <summary>
        Scenario script <span className="muted small">{next ? `next: step ${next.n}` : "all steps sent"}</span>
      </summary>
      <ol start={0}>
        {steps.map((s) => (
          <li key={s.n} className={s === next ? "next" : ""}>
            <button className="btn small" disabled={busy} onClick={() => onRun(s)} title={s.expected}>
              {sent.has(s.input) ? "Resend" : "Send"}
            </button>
            <span className="from">{s.from}</span>
            <span className="text">{s.input}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
