import { useEffect, useState } from "react";
import { formatClock, formatLocalInput, formatUsDateTime, parseUsDateTime, toLocalInput } from "../view";

const PRESETS: [string, string][] = [
  ["Scenario start", "2026-11-04T10:00"],
  ["Wed after hours", "2026-11-04T18:00"],
  ["Sat", "2026-11-07T10:00"],
  ["Veterans Day", "2026-11-11T10:00"],
];

interface Props {
  now: string;
  busy: boolean;
  onSet: (local: string) => void;
}

/** The scenario clock is a setting, not the computer's clock: change it live and the agent follows. */
export function ClockBar({ now, busy, onSet }: Props) {
  const [text, setText] = useState(formatUsDateTime(toLocalInput(now)));
  useEffect(() => {
    setText(formatUsDateTime(toLocalInput(now)));
  }, [now]);

  const local = parseUsDateTime(text); // null while it is not a real date and time
  const changed = !!local && local !== toLocalInput(now);

  return (
    <div className="clock" aria-label="Demo clock">
      <span className="clock-label">
        Demo clock <span className="tz">Pacific Time (clinic)</span>
      </span>
      <strong data-testid="clock">{formatClock(now)}</strong>
      <span className="picker">
        <input
          className={`us-date${text && !local ? " invalid" : ""}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && changed && onSet(local!)}
          placeholder="MM/DD/YYYY h:mm AM"
          aria-label="Set demo clock, MM/DD/YYYY h:mm AM, Pacific Time"
          spellCheck={false}
        />
        {changed && <span className="preview">→ {formatLocalInput(local!)}</span>}
        {text && !local && <span className="preview bad">Use MM/DD/YYYY h:mm AM (for example 11/07/2026 10:00 AM)</span>}
      </span>
      <button className="btn" disabled={busy || !changed} onClick={() => onSet(local!)}>
        Set
      </button>
      <span className="presets">
        {PRESETS.map(([label, value]) => (
          <button key={value} className="chip" disabled={busy} onClick={() => onSet(value)} title={`Set clock to ${formatUsDateTime(value)} (Pacific)`}>
            {label}
          </button>
        ))}
      </span>
    </div>
  );
}
