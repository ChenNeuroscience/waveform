import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { WaveGPU } from "./wave-gpu";
import { AnalysisPlot } from "../plots/AnalysisPlot";
import { CellStats } from "./CellStats";
import { request } from "../worker/client";
import { Superseded } from "../worker/protocol";
import { waveX, waveY, type WaveLayout } from "../plots/plot-geometry";
import { useTileGestures, type DragComparison } from "./tile-gestures";
import {
  badgeStyle,
  positionKey,
  type Trial,
  type ViewData,
  type AnalysisData,
  membershipKey,
  type Settings,
  type PlotMode,
  type SplitPoint,
  type SwapState,
  type TileFeedback,
} from "../types";
import {
  TILE_PLOTS,
  captureAnalysisPlots,
  cellStatEntries,
  type CellCapture,
  type AnalysisFrame,
} from "../app/copy-plots";
export type VisiblePlots = Record<PlotMode, boolean>;
const ROW = 124;
const STRIDE = ROW + 2;

export interface TileWallHandle {
  /** Capture cells' plots, including cells scrolled out of view. */
  capture: (cells: number[]) => Promise<CellCapture[]>;
}

/** The content size (CSS pixels) of a plot region on any rendered tile. */
function regionSize(wall: HTMLElement, selector: string) {
  const el = wall.querySelector<HTMLElement>(`.cell-tile ${selector}`);
  if (!el) {
    return null;
  }
  const style = getComputedStyle(el);
  const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Cells with tiles: populated cells, plus both halves of an open split. */
function tileCells(counts: Uint32Array, splitPoint: SplitPoint | null) {
  const split = splitPoint ? [splitPoint.source, splitPoint.source + 1] : [];
  const cells: number[] = [];
  counts.forEach((n, cell) => {
    if (n > 0 || split.includes(cell)) {
      cells.push(cell);
    }
  });
  return cells;
}

/** Tile widths from the shown plots, and the waveform frame within a tile. */
function tileSizes(shown: VisiblePlots) {
  const wavePixels = shown.waveforms ? ROW * 4 : 0;
  const tuningWidth = shown.ac ? 128 : (shown.direction ? 96 : 0) + (shown.speed ? 24 : 0);
  const numericWidth = (shown.spatial ? 128 : 0) + tuningWidth;
  const tileWidth = wavePixels + numericWidth + 3;
  // Without numeric plots the badge sits over the waveforms' right edge.
  const waveFrameWidth = numericWidth ? wavePixels : Math.max(0, wavePixels - 24);
  const waveFrameHeight = shown.waveforms ? ROW : 0;
  return {
    tuningWidth,
    numericWidth,
    tileWidth,
    tileStride: tileWidth + 2,
    waveFrameWidth,
    waveFrameHeight,
    waveFrameTop: (ROW - waveFrameHeight) / 2,
  };
}

/** The settings that change a cell's analysis (cache key). */
function analysisSettingsKey(s: Settings) {
  return [
    s.binCm,
    s.smooth,
    s.acWindow,
    s.leds,
    s.maxSpeed,
    s.posSmooth,
    s.dirBin,
    s.speedBin,
    s.speedMax,
  ].join("|");
}

/** Join the class names whose flags are set. */
function classNames(base: string, flags: Record<string, boolean>) {
  return [base, ...Object.keys(flags).filter((name) => flags[name])].join(" ");
}
/** What tile gestures do: select, hover, drag-compare and merge, start or adjust
 * a waveform split, pop a tile out, or pick the partner of a pending swap. */
export interface TileActions {
  onSelect: (n: number) => void;
  onHover: (n: number | null) => void;
  onCompare: (pair: DragComparison | null) => void;
  onMerge: (a: number, b: number) => void;
  onWaveSplit: (n: number, ch: number, t: number, v: number) => void;
  onPopOut: (n: number, x: number, y: number) => void;
  onSwapGroup: (group: number) => void;
  /** Add or remove a cell from the copy-mode selection. */
  onCopyToggle: (cell: number) => void;
}

export function TileWall({
  data,
  settings,
  trial,
  selected,
  shown,
  splitPoint,
  swap,
  copying,
  feedback,
  grabMode,
  busy,
  actions: {
    onSelect,
    onHover,
    onCompare,
    onMerge,
    onWaveSplit,
    onPopOut,
    onSwapGroup,
    onCopyToggle,
  },
  ref,
}: {
  data: ViewData;
  settings: Settings;
  /** The trial, for its position file (tile rate maps and tuning). */
  trial: Trial | undefined;
  selected: number;
  shown: VisiblePlots;
  splitPoint: SplitPoint | null;
  swap: SwapState | null;
  /** The copy-mode selection, or null outside copy mode. */
  copying: number[] | null;
  feedback: TileFeedback | null;
  grabMode: boolean;
  busy: boolean;
  actions: TileActions;
  ref?: Ref<TileWallHandle>;
}) {
  const pos = trial?.pos;
  const posKey = positionKey(trial);
  const scroller = useRef<HTMLDivElement>(null);
  const waveCanvas = useRef<HTMLCanvasElement>(null);

  // The scroller's size and scroll position, which decide the visible rows.
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(800);
  const [width, setWidth] = useState(800);

  // Tile analyses keyed by cell membership, so edits only refetch cells whose
  // spikes changed and renumbered cells keep theirs; the version re-renders.
  const cache = useRef(new Map<string, AnalysisData>());
  const [analysisVersion, setAnalysisVersion] = useState(0);

  // Hover glow and post-edit jiggle overlays, drawn in the page layer.
  const [hovered, setHovered] = useState<number | null>(null);
  const [glows, setGlows] = useState<{ cell: number; rect: DOMRect }[]>([]);
  const [jiggles, setJiggles] = useState<{ cell: number; image: string; rect: DOMRect }[]>([]);
  const playedFeedback = useRef("");

  // The waveform renderer, recreated when waveforms are toggled, and the
  // render key it last completed (for "ready" and the jiggle capture).
  const gpu = useRef<WaveGPU | null>(null);
  const [gpuGeneration, setGpuGeneration] = useState(0);
  const [wavesDone, setWavesDone] = useState("");

  const all = tileCells(data.counts, splitPoint);
  const {
    tuningWidth,
    numericWidth,
    tileWidth,
    tileStride,
    waveFrameWidth,
    waveFrameHeight,
    waveFrameTop,
  } = tileSizes(shown);
  const columns = Math.max(1, Math.floor((width - 4) / tileStride));
  const totalRows = Math.ceil(all.length / columns);
  // Render one row above and a few below the viewport.
  const startRow = Math.max(0, Math.min(totalRows - 1, Math.floor(scroll / STRIDE) - 1));
  const start = startRow * columns;
  const visible = all.slice(start, start + (Math.ceil(height / STRIDE) + 3) * columns);
  const visibleRows = Math.ceil(visible.length / columns);
  const layout: WaveLayout = {
    columns,
    tileStride,
    rowStride: STRIDE,
    waveWidth: waveFrameWidth,
    waveHeight: waveFrameHeight,
    top: waveFrameTop,
    inset: 2,
  };
  const signature = visible.join(",");
  const waveScope = `${data.session}|${data.revision}`;
  const waveKey = `${waveScope}|${signature}|${settings.density}|${settings.drift}|${waveFrameWidth}`;
  const wavesReady = wavesDone === waveKey;
  const analysisKey = `${data.key}|${posKey}|${analysisSettingsKey(settings)}`;
  // Cancels in-flight tile gestures whenever the cut or analyses change.
  const scope = `${data.session}|${data.revision}|${analysisKey}`;
  const analysisFor = (cell: number) => cache.current.get(membershipKey(data, cell));
  const gestures = useTileGestures({
    splitSource: splitPoint?.source,
    grab: grabMode,
    busy: busy || !!swap || !!copying,
    scope: `${scope}|${tileStride}|${columns}`,
    onSelect,
    onCompare,
    onMerge,
    onSplit: onWaveSplit,
    onPopOut,
    snapshot: (n) =>
      captureTile(n, `Cell ${n}`, {
        header: false,
        details: false,
        transparentBadge: true,
      })?.toDataURL(),
  });
  // Fetches missing analyses (unbatched, so the visible tiles' requests aren't
  // superseded) and draws each plot off-screen at its tile size.
  const capture = async (cells: number[]): Promise<CellCapture[]> => {
    const renderer = shown.waveforms ? gpu.current : null;
    const missing = cells.filter((cell) => !analysisFor(cell));
    const results = await Promise.all(
      missing.map((cell) =>
        request("analysis", { session: data.session, cell, pos, posKey, settings, summary: true }),
      ),
    );
    for (const result of results) {
      if (result.membership) {
        cache.current.set(result.membership, result);
      }
    }
    await renderer?.whenLoaded();
    if (renderer && (renderer !== gpu.current || renderer.scene?.data !== data)) {
      throw new Superseded("Recording changed before the clipboard capture completed.");
    }
    const wall = scroller.current!;
    const frames: AnalysisFrame[] = TILE_PLOTS.flatMap(({ mode, selector, name }) => {
      const size = shown[mode] && regionSize(wall, selector);
      return size ? [{ mode, name, ...size }] : [];
    });
    return cells.map((cell) => {
      const a = analysisFor(cell);
      const spikes = data.counts[cell];
      const plots = captureAnalysisPlots(a, spikes, !!pos, settings, frames);
      const waves = renderer?.capture(cell);
      if (waves) {
        plots.unshift({ mode: "waveforms", name: "Waveforms", canvas: waves });
      }
      return { cell, spikes, stats: cellStatEntries(a, !!pos, spikes), plots };
    });
  };
  useImperativeHandle(ref, () => ({ capture }));
  // The scroller clips ordinary shadows. Paint only the halo in the page layer,
  // above the toolbar, while leaving the shared waveform canvas unobstructed.
  useLayoutEffect(() => {
    const highlighted = new Set([
      swap?.source,
      gestures.target ?? (gestures.dragging === null ? hovered : null),
    ]);
    setGlows(
      [...highlighted].flatMap((cell) => {
        if (cell == null) {
          return [];
        }
        const row = scroller.current?.querySelector<HTMLElement>(`.cell-tile[data-cell="${cell}"]`);
        return row ? [{ cell, rect: row.getBoundingClientRect() }] : [];
      }),
    );
  }, [
    hovered,
    gestures.dragging,
    gestures.target,
    scroll,
    width,
    height,
    signature,
    tileStride,
    swap?.source,
  ]);
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      setHeight(scroller.current!.clientHeight);
      setWidth(scroller.current!.clientWidth);
    });
    ro.observe(scroller.current!);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const index = all.indexOf(selected);
    const row = Math.floor(index / columns);
    const el = scroller.current!;
    if (
      index >= 0 &&
      (row * STRIDE < el.scrollTop || (row + 1) * STRIDE > el.scrollTop + el.clientHeight)
    ) {
      el.scrollTop = row * STRIDE;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scroll only when the selection, cut or column count changes, not as cells are added
  }, [selected, data.session, columns]);
  useEffect(() => {
    cache.current.clear();
    setAnalysisVersion((v) => v + 1);
  }, [analysisKey]);
  useEffect(() => {
    let current = true;
    const batch = crypto.randomUUID();
    const missing = visible.filter((c) => !analysisFor(c));
    if (!missing.length) {
      return;
    }
    Promise.all(
      missing.map((cell) =>
        request("analysis", {
          session: data.session,
          cell,
          pos,
          posKey,
          settings,
          summary: true,
          batch,
        }),
      ),
    )
      .then((results) => {
        if (!current) {
          return;
        }
        // Stored under the membership the worker actually analysed, which can
        // differ from this render's data if an edit was processed first.
        for (const result of results) {
          if (result.membership) {
            cache.current.set(result.membership, result);
          }
        }
        while (cache.current.size > 512) {
          cache.current.delete(cache.current.keys().next().value!);
        }
        setAnalysisVersion((v) => v + 1);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by analysisKey (position and analysis settings), the visible signature and data
  }, [analysisKey, signature, data]);
  useEffect(() => {
    if (!shown.waveforms || !waveCanvas.current) {
      return;
    }
    const g = new WaveGPU(
      waveCanvas.current,
      (asset, first, count) =>
        request("wave_batch", {
          asset,
          first,
          count,
        }).then((r) => r.waves),
      setWavesDone,
    );
    gpu.current = g;
    setGpuGeneration((n) => n + 1);
    return () => {
      g.dispose();
      gpu.current = null;
    };
  }, [shown.waveforms]);
  useEffect(() => {
    gpu.current?.update({
      data,
      cells: visible,
      layout,
      density: settings.density,
      drift: settings.drift,
      readyKey: waveKey,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- waveKey covers the visible cells, density, drift and frame width
  }, [data, waveKey, columns, tileStride, gpuGeneration]);
  const waveWidth = shown.waveforms ? `${ROW * 4}px` : "0px";
  useEffect(() => {
    setJiggles([]);
  }, [scroll, width, height, scope]);
  useEffect(() => {
    if (
      !feedback ||
      feedback.id === playedFeedback.current ||
      feedback.session !== data.session ||
      feedback.revision !== data.revision ||
      (shown.waveforms && !wavesReady)
    ) {
      return;
    }
    // Capture only the updated, visible result tiles after their cached plots
    // are ready. Animate these small composites; the population stays on the GPU.
    const focused = scroller.current?.querySelector<HTMLElement>(
      `.cell-tile[data-cell="${selected}"]`,
    );
    if (!focused || feedback.cells.some((cell) => visible.includes(cell) && !analysisFor(cell))) {
      return;
    }
    const tiles = feedback.cells.flatMap((cell) => {
      const row = scroller.current?.querySelector<HTMLElement>(`.cell-tile[data-cell="${cell}"]`);
      const image =
        row &&
        captureTile(cell, "", {
          header: false,
          details: false,
          transparentBadge: true,
        });
      return row && image
        ? [
            {
              cell,
              image: image.toDataURL(),
              rect: row.getBoundingClientRect(),
            },
          ]
        : [];
    });
    if (tiles.length) {
      playedFeedback.current = feedback.id;
      setJiggles(tiles);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- analysisFor and visible change with the listed analysisVersion, data and scope
  }, [
    feedback,
    data,
    analysisVersion,
    wavesReady,
    scope,
    signature,
    selected,
    settings.density,
    shown.waveforms,
  ]);
  const isSplitTile = (cell: number) =>
    !!splitPoint && [splitPoint.source, splitPoint.source + 1].includes(cell);
  // The split gate to mark on a tile: the open split (or its live drag) on both
  // halves, or a right-drag starting a split on this tile.
  const splitMarker = (cell: number) => {
    const point = isSplitTile(cell)
      ? gestures.split || splitPoint!
      : gestures.split?.cell === cell
        ? gestures.split
        : null;
    if (!point) {
      return null;
    }
    return {
      ...point,
      x: waveX(point.channel, point.sample) * waveFrameWidth,
      y: waveFrameTop + waveY(point.threshold) * waveFrameHeight,
    };
  };
  // While a swap is pending or in copy mode, a click picks the tile instead of acting.
  const pressTile = (e: React.PointerEvent<HTMLElement>, cell: number) => {
    if (swap || copying) {
      e.preventDefault();
      return;
    }
    gestures.begin(e, cell);
  };
  const clickTileCapture = (e: React.MouseEvent, cell: number) => {
    if (!swap && !copying) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (copying) {
      onCopyToggle(cell);
    } else {
      onSwapGroup(cell);
    }
  };
  const enterTile = (cell: number) => {
    setHovered(cell);
    if (gestures.dragging === null && !grabMode && (!splitPoint || isSplitTile(cell))) {
      onHover(cell);
    }
  };
  const leaveTile = () => {
    setHovered(null);
    if (gestures.dragging === null) {
      onHover(null);
    }
  };
  return (
    <div
      className="tile-wall"
      data-splitting={splitPoint ? splitPoint.source : undefined}
      data-dragging={gestures.dragging ?? undefined}
      data-swapping={swap?.source}
      data-copying={copying ? "" : undefined}
      ref={scroller}
      onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
      aria-label="Cell tile wall"
    >
      <div className="tile-spacer" style={{ height: totalRows * STRIDE, minWidth: tileWidth + 4 }}>
        <div
          className="tile-window"
          style={{
            top: startRow * STRIDE,
            height: visibleRows * STRIDE,
            width: columns * tileStride,
          }}
        >
          {shown.waveforms && (
            <canvas
              data-density={settings.density && wavesReady ? "ready" : "pending"}
              data-waves={wavesReady ? "ready" : "pending"}
              ref={waveCanvas}
              className="tile-wave-canvas"
              style={{ width: columns * tileStride }}
              aria-label="Cell waveform tile wall"
            />
          )}
          {visible.map((cell, i) => {
            const a = analysisFor(cell);
            // The split pair or copy selection is marked; other tiles fade.
            const marked = isSplitTile(cell) || !!copying?.includes(cell);
            const marker = splitMarker(cell);
            const dragOrigin = gestures.dragging === cell || gestures.settling?.source === cell;
            return (
              <section
                key={cell}
                className={classNames("cell-tile", {
                  selected: selected === cell,
                  "swap-source": swap?.source === cell,
                  "merge-target": gestures.target === cell,
                  "tile-muted": (!!splitPoint || !!copying) && !marked,
                  "tile-marked": marked,
                  "drag-origin": dragOrigin,
                })}
                data-cell={cell}
                style={{
                  top: Math.floor(i / columns) * STRIDE,
                  left: (i % columns) * tileStride,
                  width: tileWidth,
                  height: ROW,
                }}
                onPointerDown={(e) => pressTile(e, cell)}
                onClickCapture={(e) => clickTileCapture(e, cell)}
                onContextMenu={(e) => {
                  // Right-drag on waveforms starts a split, not the context menu.
                  if ((e.target as HTMLElement).closest(".tile-waves")) {
                    e.preventDefault();
                  }
                }}
                onPointerEnter={() => enterTile(cell)}
                onPointerLeave={leaveTile}
              >
                <div
                  className="tile-waves"
                  data-plot-width={waveFrameWidth}
                  data-plot-height={waveFrameHeight}
                  data-plot-top={waveFrameTop}
                  style={{ width: waveWidth }}
                >
                  {shown.waveforms && marker && (
                    <svg className="wave-split-marker">
                      <line x1={marker.x} x2={marker.x} y1="0" y2="100%" />
                      <line x1="0" x2="100%" y1={marker.y} y2={marker.y} />
                      <text x="4" y="14">
                        {`Ch ${marker.channel + 1} · sample ${marker.sample} · ${marker.threshold}`}
                      </text>
                    </svg>
                  )}
                </div>
                <div className="tile-numeric-plots" style={{ width: numericWidth }}>
                  {shown.spatial && (
                    <div
                      className="tile-spatial"
                      style={{ paddingRight: tuningWidth ? 2 : 24 }}
                      title={`Spatial peak: ${a?.peak.toFixed(2) || "—"} Hz`}
                    >
                      {a && pos ? (
                        <AnalysisPlot
                          data={a}
                          mode="spatial"
                          maxRate={settings.maxRate}
                          rateMapSteps={settings.rateMapSteps}
                          compact
                        />
                      ) : (
                        <span className="plot-unavailable">{pos ? "…" : "No .pos"}</span>
                      )}
                    </div>
                  )}
                  {(shown.direction || shown.speed || shown.ac) && (
                    <div className="tile-tuning" style={{ width: tuningWidth }}>
                      <div className="tile-tuning-top">
                        {shown.direction && (
                          <div
                            className="tile-direction"
                            style={{ paddingRight: shown.speed ? 0 : 24 }}
                          >
                            {a && pos && (
                              <AnalysisPlot data={a} mode="direction" maxRate={0} compact />
                            )}
                          </div>
                        )}
                        {shown.speed && (
                          <div className="tile-speed">
                            {a && pos && <AnalysisPlot data={a} mode="speed" maxRate={0} compact />}
                          </div>
                        )}
                      </div>
                      {shown.ac && (
                        <div className="tile-ac">
                          {a && <AnalysisPlot data={a} mode="ac" maxRate={0} compact />}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="tile-badge">
                  <button
                    aria-label={`Select cell ${cell}`}
                    title={`Cell ${cell}${cell === 0 ? " (noise)" : ""}`}
                    style={badgeStyle(cell)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(cell);
                    }}
                  >
                    {cell}
                  </button>
                </div>
                {dragOrigin && (
                  <div
                    className="tile-drag-placeholder"
                    aria-label={`Original location of cell ${cell}`}
                  >
                    {gestures.dragging === cell ? `[group ${cell}]` : ""}
                  </div>
                )}
                {jiggles.some((tile) => tile.cell === cell) && <div className="tile-edit-cover" />}
                <CellStats entries={cellStatEntries(a, !!pos, data.counts[cell])} />
              </section>
            );
          })}
        </div>
      </div>
      {glows.map(({ cell, rect: glow }) =>
        createPortal(
          <div
            className={`tile-hover-glow ${jiggles.some((tile) => tile.cell === cell) ? "tile-result-jiggle" : ""}`}
            data-cell={cell}
            aria-hidden="true"
            style={{
              zIndex: gestures.target === null ? 90 : 1001,
              left: glow.x,
              top: glow.y,
              width: glow.width,
              height: glow.height,
            }}
          />,
          document.body,
          `glow-${cell}`,
        ),
      )}
      {jiggles.map((tile) =>
        createPortal(
          <div
            key={tile.cell}
            className="tile-edit-jiggle tile-result-jiggle"
            data-cell={tile.cell}
            aria-hidden="true"
            onAnimationEnd={() =>
              setJiggles((current) => current.filter((t) => t.cell !== tile.cell))
            }
            style={{
              left: tile.rect.x,
              top: tile.rect.y,
              width: tile.rect.width,
              height: tile.rect.height,
            }}
          >
            <img src={tile.image} alt="" />
            <span className="tile-drag-badge" style={badgeStyle(tile.cell)}>
              {tile.cell}
            </span>
          </div>,
          document.body,
          `jiggle-${tile.cell}`,
        ),
      )}
      {!all.length && <div className="no-cells">No matching cells.</div>}
      {[gestures.ghost, gestures.settling].map(
        (tile, i) =>
          tile && (
            <div
              key={i}
              className={`tile-drag-ghost ${tile.snapped ? "snapped" : ""} ${i === 1 ? "returning" : ""}`}
              aria-label={
                i === 1 ? `Returning cell ${tile.source}` : `Dragging cell ${tile.source}`
              }
              data-source={tile.source}
              data-target={tile.snapped ? gestures.target : undefined}
              style={{
                left: tile.x,
                top: tile.y,
                width: tile.width,
                height: tile.height,
              }}
            >
              <img className="tile-drag-image" alt="" src={tile.image} draggable={false} />
              <span className="tile-drag-badge" style={badgeStyle(tile.source)}>
                {tile.source}
              </span>
            </div>
          ),
      )}
    </div>
  );
}
export function captureTile(
  cell: number,
  title: string,
  options: {
    header?: boolean;
    details?: boolean;
    transparentBadge?: boolean;
  } = {},
): HTMLCanvasElement | undefined {
  const row = document.querySelector<HTMLElement>(`.cell-tile[data-cell="${cell}"]`);
  const waves = document.querySelector<HTMLCanvasElement>(".tile-wave-canvas");
  if (!row) {
    return;
  }
  const rect = row.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  const heading = options.header === false ? 0 : 28;
  const canvas = document.createElement("canvas");
  canvas.width = rect.width * dpr;
  canvas.height = (rect.height + heading) * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, rect.width - (options.transparentBadge ? 24 : 0), rect.height + heading);
  ctx.fillStyle = "black";
  ctx.font = "11px Arial";
  if (heading) {
    ctx.fillText(title, 6, 17);
  }
  const waveRegion = row.querySelector<HTMLElement>(".tile-waves")!;
  if (waves && waveRegion.clientWidth) {
    const w = waves.getBoundingClientRect();
    const region = waveRegion.getBoundingClientRect();
    const sx = waves.width / w.width;
    const sy = waves.height / w.height;
    ctx.drawImage(
      waves,
      (region.left - w.left) * sx,
      (rect.top - w.top) * sy,
      region.width * sx,
      rect.height * sy,
      region.left - rect.left,
      heading,
      region.width,
      rect.height,
    );
  }
  for (const c of row.querySelectorAll<HTMLCanvasElement>("canvas")) {
    const b = c.getBoundingClientRect();
    ctx.drawImage(c, b.left - rect.left, b.top - rect.top + heading, b.width, b.height);
  }
  const caption = row.querySelector<HTMLElement>(".tile-caption");
  if (options.details !== false && caption && getComputedStyle(caption).visibility !== "hidden") {
    const info = caption.getBoundingClientRect();
    ctx.fillStyle = "#ffffffe8";
    ctx.fillRect(info.left - rect.left, info.top - rect.top + heading, info.width, info.height);
    ctx.font = "14px Arial";
    ctx.fillStyle = "#222";
    for (const [i, line] of [...caption.querySelectorAll("span")].entries()) {
      ctx.fillText(
        line.textContent || "",
        info.left - rect.left + 6,
        info.top - rect.top + heading + 17 + i * 18,
      );
    }
  }
  if (options.transparentBadge) {
    ctx.clearRect(rect.width - 24, heading, 24, 24);
  }
  return canvas;
}
