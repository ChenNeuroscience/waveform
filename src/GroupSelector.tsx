import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { color, groupTextColor } from "./types";

export function GroupSelector({
  children,
  counts,
  sources,
  dest,
  selected,
  disabled,
  onSource,
  onDest,
  onNew,
  onHover,
}: {
  children: ReactNode;
  counts?: Uint32Array;
  sources: number[];
  dest: number;
  selected: number;
  disabled: boolean;
  onSource: (group: number, toggle: boolean) => void;
  onDest: (group: number) => void;
  onNew: () => void;
  onHover: (group: number | null) => void;
}) {
  const brace = (closing = false) => (
    <span className={`source-brace ${closing ? "closing" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 8 100" preserveAspectRatio="none">
        <path
          d="M7 1 C2 1 3 17 3 32 C3 45 1 48 1 50 C1 52 3 55 3 68 C3 83 2 99 7 99"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  );
  const chip = (group: number, role: "Destination" | "Source" | "Group") => (
    <button
      key={group}
      data-group={group}
      className={selected === group ? "active" : ""}
      aria-label={`${role}${role === "Group" ? "" : " group"} ${group}`}
      title={`Group ${group} · ${(counts?.[group] || 0).toLocaleString()} spikes. Left: destination [E]. Right: source [F]. Shift-right: toggle source [Shift-F].`}
      style={{ background: color(group), color: groupTextColor(group) }}
      disabled={disabled}
      onMouseEnter={() => onHover(group)}
      onMouseLeave={() => onHover(null)}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => onDest(group)}
      onMouseUp={(event) => {
        if (event.button !== 0) onSource(group, event.shiftKey);
      }}
    >
      {group}
    </button>
  );
  return (
    <div className="feature-controls group-selector" aria-label="Painting groups">
      <div className="feature-group-heading">
        {children}
        <div className="painting-set" aria-label="Destination and source groups">
          <span className="painting-destination">{chip(dest, "Destination")}</span>
          <span className="set-symbol" aria-hidden="true">
            ←
          </span>
          <span className="painting-sources" aria-label="Source groups">
            {brace()}
            <span className="source-chips">{sources.map((group) => chip(group, "Source"))}</span>
            {brace(true)}
          </span>
        </div>
      </div>
      <div className="feature-group-strip" aria-label="Other groups">
        {counts &&
          Array.from(counts, (count, group) => ({ count, group }))
            .filter(({ count, group }) => count && group !== dest && !sources.includes(group))
            .map(({ group }) => chip(group, "Group"))}
        <button
          className="new-group"
          aria-label="New destination group"
          title="First unused destination group [Enter]"
          disabled={disabled || !counts?.some((count, group) => group > 0 && !count)}
          onClick={onNew}
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}
