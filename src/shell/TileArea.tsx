import { TileWall } from "../tiles/TileWall";
import { fileId } from "../types";
import { SwapPrompt } from "../tiles/SwapPrompt";
import type { ShellProps } from "./props";

/** The swap prompt and the cell tile wall. */
export function TileArea(
  p: Pick<
    ShellProps,
    | "cell"
    | "data"
    | "grabMode"
    | "message"
    | "onCancelSwap"
    | "onCell"
    | "onCompare"
    | "onMerge"
    | "onPopOut"
    | "onSwapGroup"
    | "onTileHover"
    | "onWaveSplit"
    | "ready"
    | "settings"
    | "shown"
    | "splitPoint"
    | "swap"
    | "tileFeedback"
    | "trial"
  >,
) {
  return (
    <section className="right-workspace">
      {p.swap && p.data && (
        <SwapPrompt
          state={p.swap}
          counts={p.data.counts}
          onGroup={p.onSwapGroup}
          onCancel={p.onCancelSwap}
        />
      )}
      {p.data ? (
        <TileWall
          data={p.data}
          settings={p.settings}
          pos={p.trial?.pos}
          posKey={p.trial?.pos ? `${p.trial.id}|${fileId(p.trial.pos)}` : ""}
          selected={p.cell}
          shown={p.shown}
          onSelect={p.onCell}
          splitPoint={p.splitPoint}
          swap={p.swap}
          feedback={p.tileFeedback}
          onSwapGroup={p.onSwapGroup}
          grabMode={p.grabMode}
          busy={!p.ready}
          onCompare={p.onCompare}
          onHover={p.onTileHover}
          onMerge={p.onMerge}
          onWaveSplit={p.onWaveSplit}
          onPopOut={p.onPopOut}
        />
      ) : (
        <div className="pane-placeholder">{p.message || "Loading recording…"}</div>
      )}
    </section>
  );
}
