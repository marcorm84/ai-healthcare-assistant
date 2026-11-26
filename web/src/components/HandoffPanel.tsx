import { useEffect, useRef } from "react";
import type { Handoff, HandoffStatus, Message } from "../types";
import { answeredQuestions, detailRows, groupHandoffs, STATUS_LABEL, TYPE_LABEL } from "../view";

interface Props {
  handoffs: Handoff[];
  messages: Message[];
  busy: boolean;
  focusedId: string | null;
  onHover: (ids: Set<string>) => void;
  onStatus: (id: string, status: HandoffStatus) => void;
}

const NEXT: Record<HandoffStatus, [HandoffStatus, string][]> = {
  pending_staff: [["approved", "Approve"], ["completed", "Complete"], ["rejected", "Reject"]],
  approved: [["completed", "Complete"], ["rejected", "Reject"]],
  completed: [],
  rejected: [],
};

export function HandoffPanel({ handoffs, messages, busy, focusedId, onHover, onStatus }: Props) {
  const { awaiting, processed } = groupHandoffs(handoffs);
  const answered = answeredQuestions(messages);

  return (
    <aside className="handoffs" aria-label="Activity and requests">
      <h2 className="pane-title">Activity &amp; Requests</h2>

      <h3 className="section">
        Awaiting staff review <span className="count">{awaiting.length}</span>
      </h3>
      <p className="hint">Saved requests (<code>pending_staff</code>) that staff must act on.</p>
      {awaiting.length === 0 && <p className="empty small">Nothing is waiting for staff.</p>}
      {awaiting.map((h) => (
        <Card key={h.id} h={h} busy={busy} focused={focusedId === h.id} onHover={onHover} onStatus={onStatus} />
      ))}

      {processed.length > 0 && (
        <>
          <h3 className="section sub">
            Processed by staff <span className="count">{processed.length}</span>
          </h3>
          {processed.map((h) => (
            <Card key={h.id} h={h} busy={busy} focused={focusedId === h.id} onHover={onHover} onStatus={onStatus} />
          ))}
        </>
      )}

      <h3 className="section">
        Answered directly by assistant <span className="count">{answered.length}</span>
      </h3>
      <p className="hint">Questions resolved from the record or the FAQ, with no staff involved.</p>
      {answered.length === 0 && <p className="empty small">No questions answered directly yet.</p>}
      <ul className="answered">
        {answered.map((a) => (
          <li key={a.id} onMouseEnter={() => onHover(new Set([a.id]))} onMouseLeave={() => onHover(new Set())}>
            <span className="q">{a.question}</span>
            <span className="a">{a.answer}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Card({ h, busy, focused, onHover, onStatus }: { h: Handoff; busy: boolean; focused: boolean } & Pick<Props, "onHover" | "onStatus">) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);
  const actions = NEXT[h.status];

  return (
    <article
      ref={ref}
      className={`card ${h.type}${focused ? " focus" : ""}`}
      onMouseEnter={() => onHover(new Set(h.source_message_ids))}
      onMouseLeave={() => onHover(new Set())}
    >
      <div className="card-head">
        <strong>{TYPE_LABEL[h.type]}</strong>
        <span className={`pill ${h.status}`}>{STATUS_LABEL[h.status]}</span>
      </div>
      <dl>
        {detailRows(h).map(([k, v]) => (
          <div key={k} className="row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="meta">
        <span>
          Request ID <code>{h.id}</code>
        </span>
        <span>
          from {h.source_message_ids.length} message{h.source_message_ids.length === 1 ? "" : "s"}
        </span>
      </div>
      {actions.length > 0 && (
        <div className="actions" role="group" aria-label="Simulated staff actions">
          <span className="actions-label">Simulate staff:</span>
          {actions.map(([status, label]) => (
            <button key={status} className="btn small" disabled={busy} onClick={() => onStatus(h.id, status)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
