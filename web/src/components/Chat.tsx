import { useEffect, useMemo, useRef, useState } from "react";
import type { Message, View } from "../types";
import { outcomeTag } from "../view";

type Role = "patient" | "clinic";

interface Props {
  view: View;
  busy: boolean;
  /** Messages to highlight (the sources of the handoff being hovered). */
  highlight: Set<string>;
  /** A reply the server could not save; shown so Alex still sees it, clearly marked. */
  unsaved: string | null;
  onSend: (role: Role, text: string) => Promise<void>;
  onFocusHandoff: (id: string) => void;
}

const SENDER_LABEL = { clinic: "Clinic", patient: "Alex", agent: "Assistant" } as const;

export function Chat({ view, busy, highlight, unsaved, onSend, onFocusHandoff }: Props) {
  const [role, setRole] = useState<Role>("patient");
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [view.messages.length, unsaved]);

  // An agent reply is highlighted together with the message it answered.
  const lit = useMemo(() => {
    const ids = new Set(highlight);
    for (const m of view.messages) if (m.in_reply_to && highlight.has(m.in_reply_to)) ids.add(m.id);
    return ids;
  }, [highlight, view.messages]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    await onSend(role, value);
  }

  return (
    <section className="chat" aria-label="Conversation">
      <header className="pane-title">
        <span>Conversation · {view.patient.name}</span>
        <span className="muted small">from {view.patient.phone}</span>
      </header>

      <div className="messages" role="log" aria-live="polite">
        {view.messages.length === 0 && (
          <p className="empty">No messages yet. Send the clinic's first message below, or use “Scenario script”.</p>
        )}
        {view.messages.map((m) => (
          <Bubble key={m.id} m={m} lit={lit.has(m.id)} messages={view.messages} onFocusHandoff={onFocusHandoff} />
        ))}
        {unsaved && (
          <div className="msg agent unsaved" role="alert">
            <div className="who">Assistant</div>
            <div className="body">{unsaved}</div>
            <span className="tag danger">Not saved: this message and reply are not in the record</span>
          </div>
        )}
        {busy && <div className="typing">Working…</div>}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={submit}>
        <div className="role" role="radiogroup" aria-label="Send as">
          {(["patient", "clinic"] as const).map((r) => (
            <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>
              {r === "patient" ? "As Alex" : "As clinic"}
            </button>
          ))}
        </div>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={role === "patient" ? "Type a message as Alex…" : "Type an outbound clinic message…"}
          aria-label="Message"
          disabled={busy}
        />
        <button className="send" type="submit" disabled={busy || !text.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        </button>
      </form>
    </section>
  );
}

function Bubble({ m, lit, messages, onFocusHandoff }: { m: Message; lit: boolean; messages: Message[]; onFocusHandoff: (id: string) => void }) {
  const tag = outcomeTag(m, messages);
  return (
    <div className={`msg ${m.sender}${lit ? " lit" : ""}`}>
      <div className="who">{SENDER_LABEL[m.sender]}</div>
      <div className="body">{m.body}</div>
      {tag && (
        <button
          className={`tag ${tag.tone}`}
          disabled={!tag.handoffId}
          onClick={() => tag.handoffId && onFocusHandoff(tag.handoffId)}
          title={tag.handoffId ? "Show this request" : undefined}
        >
          {tag.label}
        </button>
      )}
    </div>
  );
}
