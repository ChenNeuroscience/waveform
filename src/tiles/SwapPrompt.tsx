import { useState } from "react";
import type { SwapState } from "../types";

/** Why a typed swap target is invalid, or "" if it is fine. */
function swapError(value: string, source: number, groups: number) {
  const target = Number(value);
  if (!value.trim() || !Number.isInteger(target) || target < 0 || target >= groups) {
    return `Enter a group number from 0 to ${groups - 1}.`;
  }
  return target === source ? "Choose a different group." : "";
}

export function SwapPrompt({
  state,
  counts,
  onGroup,
  onCancel,
}: {
  state: SwapState;
  counts: Uint32Array;
  onGroup: (group: number) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const source = state.source;
  const cancelOnEscape = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const problem = swapError(value, source, counts.length);
    if (problem) {
      setError(problem);
    } else {
      onGroup(Number(value));
    }
  };
  return (
    <form
      className="swap-prompt"
      role="region"
      aria-label="Swap groups"
      onKeyDown={cancelOnEscape}
      onSubmit={submit}
    >
      <div className="swap-instructions" role="status">
        Swap group {source}: click or type a group to swap with. Esc to cancel.
      </div>
      <input
        autoFocus
        type="text"
        inputMode="numeric"
        aria-label="Group to swap with"
        placeholder="Group"
        value={value}
        aria-invalid={!!error}
        aria-describedby={error ? "swap-error" : undefined}
        onChange={(event) => {
          setValue(event.target.value);
          setError("");
        }}
      />
      <button type="submit">Swap</button>
      {[-1, 1].map((delta) => {
        const target = source + delta;
        return target >= 0 && target < counts.length && !counts[target] ? (
          <button
            type="button"
            key={delta}
            onClick={() => onGroup(target)}
            title={`Move group ${source} to unused group ${target}`}
          >
            Swap {delta < 0 ? "−1" : "+1"} (empty {target})
          </button>
        ) : null;
      })}
      <button type="button" onClick={onCancel}>
        Cancel [Esc]
      </button>
      {error && (
        <div id="swap-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
