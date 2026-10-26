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
    <div
      className="feature-controls group-selector"
      aria-label="Painting groups"
    >
      <div className="feature-group-heading">
        {children}
        <div
          className="painting-set"
          aria-label="Destination and source groups"
        >
          <span className="painting-destination">
            {chip(dest, "Destination")}
          </span>
          <span className="set-symbol" aria-hidden="true">
            ←
          </span>
          <span className="painting-sources" aria-label="Source groups">
            <span className="set-symbol" aria-hidden="true">
              {"{"}
            </span>
            {sources.map((group) => chip(group, "Source"))}
            <span className="set-symbol" aria-hidden="true">
              {"}"}
            </span>
          </span>
        </div>
      </div>
      <div className="feature-group-strip" aria-label="Other groups">
        {counts &&
          Array.from(counts, (count, group) => ({ count, group }))
            .filter(
              ({ count, group }) =>
                count && group !== dest && !sources.includes(group),
            )
            .map(({ group }) => chip(group, "Group"))}
        <button
          className="new-group"
          aria-label="New destination group"
          title="First unused destination group [Enter]"
          disabled={
            disabled || !counts?.some((count, group) => group > 0 && !count)
          }
          onClick={onNew}
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}
