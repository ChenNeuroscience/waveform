import { useState } from "react";
import type { SwapState } from "./types";
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
  const [value, setValue] = useState(""),
    [error, setError] = useState("");
  const source = state.source;
  return (
    <form
      className="swap-prompt"
      role="region"
      aria-label="Swap groups"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const target = Number(value);
        if (
          !value.trim() ||
          !Number.isInteger(target) ||
          target < 0 ||
          target >= counts.length
        )
          setError(`Enter a group number from 0 to ${counts.length - 1}.`);
        else if (target === source) setError("Choose a different group.");
        else onGroup(target);
      }}
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
