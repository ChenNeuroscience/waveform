import { useEffect, useRef, useState } from "react";
import { drawWaveOverview } from "./gpu";
import { drawDensity } from "./density-gpu";
import { AnalysisPlot } from "./plots";
import { request } from "./client";
import type { WaveLayout } from "./plot-geometry";
import { useTileGestures, type DragComparison } from "./tile-gestures";
import {
  color,
  type ViewData,
  type AnalysisData,
  type Settings,
  type PlotMode,
  type SplitPoint,
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
  filter,
  sort,
  onSelect,
  splitPoint,
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
  filter: string;
  sort: boolean;
  onSelect: (n: number) => void;
  splitPoint: SplitPoint | null;
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
    [height, setHeight] = useState(800),
    [width, setWidth] = useState(800),
    [density, setDensity] = useState<{
      key: string;
      texture: Uint16Array;
    } | null>(null);
  const all = Array.from(data.counts, (n, i) => ({ n, i }))
    .filter(
      (c) =>
        (c.n > 0 && String(c.i).includes(filter)) ||
        (splitPoint &&
          [splitPoint.source, splitPoint.source + 1].includes(c.i)),
    )
    .sort((a, b) => (sort && !splitPoint ? b.n - a.n : a.i - b.i))
    .map((c) => c.i);
  const wavePixels = shown.waveforms ? ROW * 4 : 0,
    tuningWidth = shown.ac
      ? 128
      : (shown.direction ? 96 : 0) + (shown.speed ? 24 : 0),
    numericWidth = (shown.spatial ? 128 : 0) + tuningWidth,
    tileWidth = wavePixels + numericWidth + 27,
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
      waveWidth: wavePixels,
      waveHeight: ROW,
      inset: 2,
    },
    signature = visible.join(","),
    waveScope = `${data.session}|${data.revision}`,
    scope = `${data.session}|${data.revision}|${posKey}|${settings.binCm}|${settings.smooth}|${settings.acWindow}|${settings.leds}|${settings.maxSpeed}|${settings.posSmooth}|${settings.dirBin}|${settings.speedBin}`;
  const gestures = useTileGestures({
    splitSource: splitPoint?.source,
    grab: grabMode,
    busy,
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
        setMaps(new Map(cache.current));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [scope, signature]);
  useEffect(() => {
    let live = true;
    if (settings.density && shown.waveforms && visible.length)
      request<{ texture: Uint16Array }>("wave_density", {
        session: data.session,
        cells: visible,
      })
        .then((r) => {
          if (live)
            setDensity({
              key: waveScope + "|" + signature,
              texture: r.texture,
            });
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [waveScope, signature, settings.density, shown.waveforms]);
  useEffect(() => {
    if (!shown.waveforms || !waveCanvas.current) return;
    if (settings.density && density?.key === waveScope + "|" + signature)
      return drawDensity(
        waveCanvas.current,
        density.texture,
        visible.length,
        layout,
      );
    return drawWaveOverview(waveCanvas.current, data, visible, columns, layout);
  }, [
    data,
    signature,
    columns,
    tileStride,
    shown.waveforms,
    settings.density,
    density,
  ]);
  const waveWidth = shown.waveforms ? `${ROW * 4}px` : "0px";
  return (
    <div
      className="tile-wall"
      data-splitting={splitPoint ? splitPoint.source : undefined}
      data-dragging={gestures.dragging ?? undefined}
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
                settings.density && density?.key === waveScope + "|" + signature
                  ? "ready"
                  : "pending"
              }
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
                      (point.channel + 0.08 + (0.84 * point.sample) / 49) * ROW,
                    y: ((64 - point.threshold * 0.39) * ROW) / 128,
                  }
                : null;
            return (
              <section
                key={cell}
                className={`cell-tile ${selected === cell ? "selected" : ""} ${gestures.target === cell ? "merge-target" : ""} ${splitPoint && !paired ? "split-muted" : ""} ${paired ? "split-pair" : ""} ${gestures.dragging === cell || gestures.settling?.source === cell ? "drag-origin" : ""}`}
                data-cell={cell}
                style={{
                  top: Math.floor(i / columns) * STRIDE,
                  left: (i % columns) * tileStride,
                  width: tileWidth,
                  height: ROW,
                }}
                onPointerDown={(e) => gestures.begin(e, cell)}
                onContextMenu={(e) => {
                  if ((e.target as HTMLElement).closest(".tile-waves"))
                    e.preventDefault();
                }}
                onPointerEnter={() => {
                  if (
                    gestures.dragging === null &&
                    !grabMode &&
                    (!splitPoint || paired)
                  )
                    onHover(cell);
                }}
                onPointerLeave={() => {
                  if (gestures.dragging === null) onHover(null);
                }}
              >
                <div className="tile-waves" style={{ width: waveWidth }}>
                  {shown.waveforms && (
                    <>
                      <span className="wave-channel-names">
                        1 &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 2
                        &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 3
                        &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 4
                      </span>
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
                      <span className="tile-wave-caption">
                        {data.waveLabels.filter((c) => c === cell).length}{" "}
                        sampled waves
                      </span>
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
                          <div className="tile-direction">
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
                          {a?.sampledPairs && (
                            <span title="Sampled reference spikes">s</span>
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
                      background: cell ? color(cell) : "#e9e9e9",
                      color: cell ? "white" : "black",
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
                <div className="tile-caption">
                  <span>{data.counts[cell].toLocaleString()} spikes</span>
                  <span>{a ? `${a.rate.toFixed(2)} Hz` : "…"}</span>
                  {a && pos && <span>spa {a.peak.toFixed(1)} Hz</span>}
                  {a && (
                    <span title="Consecutive intervals under 2 ms">
                      ISI {a.refractory.toFixed(2)}%
                    </span>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
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
                  background: tile.source ? color(tile.source) : "#e9e9e9",
                  color: tile.source ? "white" : "black",
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
  return canvas;
}
