import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WaveGPU } from "./wave-gpu";
import { AnalysisPlot } from "./plots";
import { CellStats } from "./CellStats";
import { request } from "./client";
import type { WaveLayout } from "./plot-geometry";
import { useTileGestures, type DragComparison } from "./tile-gestures";
import {
  color,
  groupTextColor,
  type ViewData,
  type AnalysisData,
  type Settings,
  type PlotMode,
  type SplitPoint,
  type SwapState,
  type TileFeedback,
} from "./types";
export type VisiblePlots = Record<PlotMode, boolean>;
const ROW = 124,
  STRIDE = ROW + 2;
export function TileWall({
  data,
  settings,
  pos,
  posKey,
  selected,
  shown,
  onSelect,
  splitPoint,
  swap,
  feedback,
  onSwapGroup,
  grabMode,
  busy,
  onCompare,
  onHover,
  onMerge,
  onWaveSplit,
  onPopOut,
}: {
  data: ViewData;
  settings: Settings;
  pos?: File;
  posKey: string;
  selected: number;
  shown: VisiblePlots;
  onSelect: (n: number) => void;
  splitPoint: SplitPoint | null;
  swap: SwapState | null;
  feedback: TileFeedback | null;
  onSwapGroup: (group: number) => void;
  grabMode: boolean;
  busy: boolean;
  onCompare: (pair: DragComparison | null) => void;
  onHover: (n: number | null) => void;
  onMerge: (a: number, b: number) => void;
  onWaveSplit: (n: number, ch: number, t: number, v: number) => void;
  onPopOut: (n: number, x: number, y: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null),
    waveCanvas = useRef<HTMLCanvasElement>(null),
    cache = useRef(new Map<number, AnalysisData>()),
    [maps, setMaps] = useState(new Map<number, AnalysisData>()),
    [scroll, setScroll] = useState(0),
    [hovered, setHovered] = useState<number | null>(null),
    [glows, setGlows] = useState<{ cell: number; rect: DOMRect }[]>([]),
    [jiggles, setJiggles] = useState<
      { cell: number; image: string; rect: DOMRect }[]
    >([]),
    playedFeedback = useRef(""),
    analysisScope = useRef(""),
    [height, setHeight] = useState(800),
    [width, setWidth] = useState(800),
    gpu = useRef<WaveGPU | null>(null),
    [gpuGeneration, setGpuGeneration] = useState(0),
    [wavesDone, setWavesDone] = useState("");
  const all = Array.from(data.counts, (n, i) => ({ n, i }))
    .filter(
      (c) =>
        c.n > 0 ||
        (splitPoint &&
          [splitPoint.source, splitPoint.source + 1].includes(c.i)),
    )
    .sort((a, b) => a.i - b.i)
    .map((c) => c.i);
  const wavePixels = shown.waveforms ? ROW * 4 : 0,
    tuningWidth = shown.ac
      ? 128
      : (shown.direction ? 96 : 0) + (shown.speed ? 24 : 0),
    numericWidth = (shown.spatial ? 128 : 0) + tuningWidth,
    tileWidth = wavePixels + numericWidth + 3,
    waveFrameWidth = numericWidth ? wavePixels : Math.max(0, wavePixels - 24),
    waveFrameHeight = waveFrameWidth / 4,
    waveFrameTop = (ROW - waveFrameHeight) / 2,
    tileStride = tileWidth + 2,
    columns = Math.max(1, Math.floor((width - 4) / tileStride)),
    totalRows = Math.ceil(all.length / columns),
    startRow = Math.max(
      0,
      Math.min(totalRows - 1, Math.floor(scroll / STRIDE) - 1),
    ),
    start = startRow * columns,
    visible = all.slice(
      start,
      start + (Math.ceil(height / STRIDE) + 3) * columns,
    ),
    visibleRows = Math.ceil(visible.length / columns),
    layout: WaveLayout = {
      columns,
      tileStride,
      rowStride: STRIDE,
      waveWidth: waveFrameWidth,
      waveHeight: waveFrameHeight,
      top: waveFrameTop,
      inset: 2,
    },
    signature = visible.join(","),
    waveScope = `${data.session}|${data.revision}`,
    waveKey = `${waveScope}|${signature}|${settings.density}|${waveFrameWidth}`,
    wavesReady = wavesDone === waveKey,
    scope = `${data.session}|${data.revision}|${posKey}|${settings.binCm}|${settings.smooth}|${settings.acWindow}|${settings.leds}|${settings.maxSpeed}|${settings.posSmooth}|${settings.dirBin}|${settings.speedBin}|${settings.speedMax}`;
  const gestures = useTileGestures({
    splitSource: splitPoint?.source,
    grab: grabMode,
    busy: busy || !!swap,
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
  // The scroller clips ordinary shadows. Paint only the halo in the page layer,
  // above the toolbar, while leaving the shared waveform canvas unobstructed.
  useLayoutEffect(() => {
    const highlighted = new Set([
      swap?.source,
      gestures.target ?? (gestures.dragging === null ? hovered : null),
    ]);
    setGlows(
      [...highlighted].flatMap((cell) => {
        if (cell == null) return [];
        const row = scroller.current?.querySelector<HTMLElement>(
          `.cell-tile[data-cell="${cell}"]`,
        );
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
    const index = all.indexOf(selected),
      row = Math.floor(index / columns),
      el = scroller.current!;
    if (
      index >= 0 &&
      (row * STRIDE < el.scrollTop ||
        (row + 1) * STRIDE > el.scrollTop + el.clientHeight)
    )
      el.scrollTop = row * STRIDE;
  }, [selected, data.session, columns]);
  useEffect(() => {
    analysisScope.current = "";
    cache.current.clear();
    setMaps(new Map());
  }, [scope]);
  useEffect(() => {
    let current = true;
    const batch = crypto.randomUUID(),
      missing = visible.filter((c) => !cache.current.has(c));
    Promise.all(
      missing.map((cell) =>
        request<AnalysisData>("analysis", {
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
        if (!current) return;
        for (const result of results) cache.current.set(result.cell, result);
        analysisScope.current = scope;
        setMaps(new Map(cache.current));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [scope, signature]);
  useEffect(() => {
    if (!shown.waveforms || !waveCanvas.current) return;
    const g = new WaveGPU(
      waveCanvas.current,
      (asset, first, count) =>
        request<{ waves: Uint8Array }>("wave_batch", {
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
      readyKey: waveKey,
    });
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
      analysisScope.current !== scope ||
      (shown.waveforms && !wavesReady)
    )
      return;
    // Capture only the updated, visible result tiles after their cached plots
    // are ready. Animate these small composites; the population stays on the GPU.
    const focused = scroller.current?.querySelector<HTMLElement>(
      `.cell-tile[data-cell="${selected}"]`,
    );
    if (
      !focused ||
      feedback.cells.some((cell) => visible.includes(cell) && !maps.has(cell))
    )
      return;
    const tiles = feedback.cells.flatMap((cell) => {
      const row = scroller.current?.querySelector<HTMLElement>(
          `.cell-tile[data-cell="${cell}"]`,
        ),
        image =
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
  }, [
    feedback,
    data,
    maps,
    wavesReady,
    scope,
    signature,
    selected,
    settings.density,
    shown.waveforms,
  ]);
  return (
    <div
      className="tile-wall"
      data-splitting={splitPoint ? splitPoint.source : undefined}
      data-dragging={gestures.dragging ?? undefined}
      data-swapping={swap?.source}
      ref={scroller}
      onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
      aria-label="Cell tile wall"
    >
      <div
        className="tile-spacer"
        style={{ height: totalRows * STRIDE, minWidth: tileWidth + 4 }}
      >
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
              data-density={
                settings.density && wavesReady ? "ready" : "pending"
              }
              data-waves={wavesReady ? "ready" : "pending"}
              ref={waveCanvas}
              className="tile-wave-canvas"
              style={{ width: columns * tileStride }}
              aria-label="Cell waveform tile wall"
            />
          )}
          {visible.map((cell, i) => {
            const a = maps.get(cell),
              paired =
                !!splitPoint &&
                [splitPoint.source, splitPoint.source + 1].includes(cell),
              point = paired
                ? gestures.split || {
                    channel: splitPoint!.channel,
                    sample: splitPoint!.sample,
                    threshold: splitPoint!.threshold,
                  }
                : gestures.split?.cell === cell
                  ? gestures.split
                  : null,
              marker = point
                ? {
                    x:
                      ((point.channel + 0.08 + (0.84 * point.sample) / 49) *
                        waveFrameWidth) /
                      4,
                    y:
                      waveFrameTop +
                      ((64 - point.threshold * 0.39) * waveFrameHeight) / 128,
                  }
                : null;
            return (
              <section
                key={cell}
                className={`cell-tile ${selected === cell ? "selected" : ""} ${swap?.source === cell ? "swap-source" : ""} ${gestures.target === cell ? "merge-target" : ""} ${splitPoint && !paired ? "split-muted" : ""} ${paired ? "split-pair" : ""} ${gestures.dragging === cell || gestures.settling?.source === cell ? "drag-origin" : ""}`}
                data-cell={cell}
                style={{
                  top: Math.floor(i / columns) * STRIDE,
                  left: (i % columns) * tileStride,
                  width: tileWidth,
                  height: ROW,
                }}
                onPointerDown={(e) => {
                  if (swap) {
                    e.preventDefault();
                    return;
                  }
                  gestures.begin(e, cell);
                }}
                onClickCapture={(e) => {
                  if (!swap) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onSwapGroup(cell);
                }}
                onContextMenu={(e) => {
                  if ((e.target as HTMLElement).closest(".tile-waves"))
                    e.preventDefault();
                }}
                onPointerEnter={() => {
                  setHovered(cell);
                  if (
                    gestures.dragging === null &&
                    !grabMode &&
                    (!splitPoint || paired)
                  )
                    onHover(cell);
                }}
                onPointerLeave={() => {
                  setHovered(null);
                  if (gestures.dragging === null) onHover(null);
                }}
              >
                <div
                  className="tile-waves"
                  data-plot-width={waveFrameWidth}
                  data-plot-height={waveFrameHeight}
                  data-plot-top={waveFrameTop}
                  style={{ width: waveWidth }}
                >
                  {shown.waveforms && (
                    <>
                      {marker && (
                        <svg className="wave-split-marker">
                          <line x1={marker.x} x2={marker.x} y1="0" y2="100%" />
                          <line x1="0" x2="100%" y1={marker.y} y2={marker.y} />
                          <text
                            x="4"
                            y="14"
                          >{`Ch ${point!.channel + 1} · sample ${point!.sample} · ${point!.threshold}`}</text>
                        </svg>
                      )}
                    </>
                  )}
                </div>
                <div
                  className="tile-numeric-plots"
                  style={{ width: numericWidth }}
                >
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
                          compact
                        />
                      ) : (
                        <span className="plot-unavailable">
                          {pos ? "…" : "No .pos"}
                        </span>
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
                              <AnalysisPlot
                                data={a}
                                mode="direction"
                                maxRate={0}
                                compact
                              />
                            )}
                          </div>
                        )}
                        {shown.speed && (
                          <div className="tile-speed">
                            {a && pos && (
                              <AnalysisPlot
                                data={a}
                                mode="speed"
                                maxRate={0}
                                compact
                              />
                            )}
                          </div>
                        )}
                      </div>
                      {shown.ac && (
                        <div className="tile-ac">
                          {a && (
                            <AnalysisPlot
                              data={a}
                              mode="ac"
                              maxRate={0}
                              compact
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="tile-badge">
                  <button
                    aria-label={`Select cell ${cell}`}
                    title={`Cell ${cell}${cell === 0 ? " (noise)" : ""}`}
                    style={{
                      background: color(cell),
                      color: groupTextColor(cell),
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(cell);
                    }}
                  >
                    {cell}
                  </button>
                </div>
                {(gestures.dragging === cell ||
                  gestures.settling?.source === cell) && (
                  <div
                    className="tile-drag-placeholder"
                    aria-label={`Original location of cell ${cell}`}
                  >
                    {gestures.dragging === cell ? `[group ${cell}]` : ""}
                  </div>
                )}
                {jiggles.some((tile) => tile.cell === cell) && (
                  <div className="tile-edit-cover" />
                )}
                <CellStats
                  entries={[
                    ...(a && pos && a.peak > 0
                      ? [{ label: "spa max", value: `${a.peak.toFixed(1)}Hz` }]
                      : []),
                    ...(a && pos && Math.max(...a.direction) > 0
                      ? [
                          {
                            label: "dir max",
                            value: `${Math.max(...a.direction).toFixed(1)}Hz`,
                          },
                        ]
                      : []),
                    {
                      label: "n spikes",
                      value: data.counts[cell].toLocaleString(),
                    },
                  ]}
                />
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
              setJiggles((current) =>
                current.filter((t) => t.cell !== tile.cell),
              )
            }
            style={{
              left: tile.rect.x,
              top: tile.rect.y,
              width: tile.rect.width,
              height: tile.rect.height,
            }}
          >
            <img src={tile.image} alt="" />
            <span
              className="tile-drag-badge"
              style={{
                background: color(tile.cell),
                color: groupTextColor(tile.cell),
              }}
            >
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
                i === 1
                  ? `Returning cell ${tile.source}`
                  : `Dragging cell ${tile.source}`
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
              <img
                className="tile-drag-image"
                alt=""
                src={tile.image}
                draggable={false}
              />
              <span
                className="tile-drag-badge"
                style={{
                  background: color(tile.source),
                  color: groupTextColor(tile.source),
                }}
              >
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
  const row = document.querySelector<HTMLElement>(
      `.cell-tile[data-cell="${cell}"]`,
    ),
    waves = document.querySelector<HTMLCanvasElement>(".tile-wave-canvas");
  if (!row) return;
  const rect = row.getBoundingClientRect(),
    dpr = Math.min(2, devicePixelRatio || 1),
    heading = options.header === false ? 0 : 28,
    canvas = document.createElement("canvas");
  canvas.width = rect.width * dpr;
  canvas.height = (rect.height + heading) * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "white";
  ctx.fillRect(
    0,
    0,
    rect.width - (options.transparentBadge ? 24 : 0),
    rect.height + heading,
  );
  ctx.fillStyle = "black";
  ctx.font = "11px Arial";
  if (heading) ctx.fillText(title, 6, 17);
  const waveRegion = row.querySelector<HTMLElement>(".tile-waves")!;
  if (waves && waveRegion.clientWidth) {
    const w = waves.getBoundingClientRect(),
      region = waveRegion.getBoundingClientRect(),
      sx = waves.width / w.width,
      sy = waves.height / w.height;
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
    ctx.drawImage(
      c,
      b.left - rect.left,
      b.top - rect.top + heading,
      b.width,
      b.height,
    );
  }
  const caption = row.querySelector<HTMLElement>(".tile-caption");
  if (
    options.details !== false &&
    caption &&
    getComputedStyle(caption).visibility !== "hidden"
  ) {
    const info = caption.getBoundingClientRect();
    ctx.fillStyle = "#ffffffe8";
    ctx.fillRect(
      info.left - rect.left,
      info.top - rect.top + heading,
      info.width,
      info.height,
    );
    ctx.font = "14px Arial";
    ctx.fillStyle = "#222";
    for (const [i, line] of [...caption.querySelectorAll("span")].entries())
      ctx.fillText(
        line.textContent || "",
        info.left - rect.left + 6,
        info.top - rect.top + heading + 17 + i * 18,
      );
  }
  if (options.transparentBadge) ctx.clearRect(rect.width - 24, heading, 24, 24);
  return canvas;
}
