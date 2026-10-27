import { Lasso, Paintbrush } from "lucide-react";
import { Clusters } from "../plots/FeatureView";
import { GroupSelector } from "./GroupSelector";
import type { ShellProps } from "./props";

const FULL_RANGE = [0, 1];

/** Group selector, paint/lasso tools and the feature-space projections. */
export function FeaturePane(
  p: Pick<
    ShellProps,
    | "cell"
    | "data"
    | "dest"
    | "grabMode"
    | "isolate"
    | "onDest"
    | "onHover"
    | "onNewGroup"
    | "onPolygon"
    | "onPopPlot"
    | "onSource"
    | "onTool"
    | "ready"
    | "settings"
    | "sources"
    | "splitPoint"
    | "swap"
    | "tool"
  >,
) {
  return (
    <section className="feature-pane">
      <GroupSelector
        counts={p.data?.counts}
        sources={p.sources}
        dest={p.dest}
        selected={p.cell}
        disabled={!p.ready || !!p.swap || !!p.splitPoint}
        onSource={p.onSource}
        onDest={p.onDest}
        onNew={p.onNewGroup}
        onHover={p.onHover}
      >
        <div className="feature-tools">
          <button
            className={p.tool === "brush" ? "active" : ""}
            aria-label="Paint source spikes"
            title="Paint source spikes"
            onClick={() => p.onTool("brush")}
          >
            <Paintbrush size={14} />
          </button>
          <button
            className={p.tool === "lasso" ? "active" : ""}
            aria-label="Lasso cut"
            title="Lasso source spikes [L]"
            onClick={() => p.onTool("lasso")}
          >
            <Lasso size={14} />
          </button>
        </div>
      </GroupSelector>
      <div
        className="feature-stage"
        onPointerDownCapture={(e) => {
          if (p.grabMode && e.button === 0) {
            e.preventDefault();
            e.stopPropagation();
            p.onPopPlot("features", e.clientX, e.clientY);
          }
        }}
      >
        {p.data && (
          <Clusters
            data={p.data}
            settings={p.settings}
            selected={p.cell}
            isolate={p.isolate}
            range={FULL_RANGE}
            tool={p.ready && !p.swap ? p.tool : "disabled"}
            onPolygon={p.onPolygon}
            onPick={(group, source, toggle) =>
              source ? p.onSource(group, toggle) : p.onDest(group)
            }
          />
        )}
      </div>
    </section>
  );
}
