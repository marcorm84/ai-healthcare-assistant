import type { View } from "../types";

interface Props {
  agent: View["agent"];
  busy: boolean;
  onToggle: (on: boolean) => void;
}

/**
 * AI assist switch. Off by default and disabled without an API key. When on, an OpenAI model only
 * CLASSIFIES messages the rules didn't understand; replies are still the clinic's templates.
 */
export function AiToggle({ agent, busy, onToggle }: Props) {
  const on = agent.llm_enabled;
  const disabled = busy || !agent.llm_available;
  return (
    <div className="ai" title={agent.llm_available ? "Only the text of Alex's message is sent, never his record. The model only classifies; it never writes replies." : "Add OPENAI_API_KEY to .env (see .env.example) and restart the API to enable AI assist."}>
      <button role="switch" aria-checked={on} aria-label="AI assist" className={`switch${on ? " on" : ""}`} disabled={disabled} onClick={() => onToggle(!on)}>
        <span className="knob" />
      </button>
      <span className="ai-text">
        <strong>AI assist {on ? "ON" : "OFF"}</strong>
        <span className="muted small">
          {!agent.llm_available ? "no API key (rules only)" : on ? `${agent.model} classifies unclear messages` : "rules only"}
        </span>
      </span>
    </div>
  );
}
