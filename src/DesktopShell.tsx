import {
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  FolderOpen,
  Folder,
  Undo2,
  Redo2,
  Keyboard,
  Settings2,
  History,
  List,
  Lasso,
  Paintbrush,
  X,
  HelpCircle,
} from "lucide-react";
import { Clusters, AnalysisPlot, PathPlot } from "./plots";
import { TileWall, type VisiblePlots } from "./TileWall";
import {
  color,
  fileId,
  type Trial,
  type Tetrode,
  type CutFile,
  type ViewData,
  type Trajectory,
  type AnalysisData,
  type Settings,
  type PlotMode,
  type SplitPoint,
} from "./types";
import type { DragComparison } from "./tile-gestures";
import { CutDownloads, cutDownloadKey } from "./cut-downloads";
import { usePreference, defaultLayout, fitPaneLayout } from "./preferences";
import { experimentTiming } from "./position-info";
import { GroupSelector } from "./GroupSelector";
import { SwapPrompt } from "./SwapPrompt";
import type { SwapState, TileFeedback } from "./types";
import video from "../img/demo_youtube.png";
interface Props {
  trials: Trial[];
  trial?: Trial;
  tetNum: number;
  cutId: string;
  data: ViewData | null;
  analysis: AnalysisData | null;
  trajectory: Trajectory | null;
  settings: Settings;
  cell: number;
  sources: number[];
  dest: number;
  tool: string;
  isolate: boolean;
  shown: VisiblePlots;
  splitPoint: SplitPoint | null;
  swap: SwapState | null;
  tileFeedback: TileFeedback | null;
  onSwapGroup: (group: number) => void;
  onCancelSwap: () => void;
  grabMode: boolean;
  hoverCell: number | null;
  dragComparison: DragComparison | null;
  comparisonAnalysis: AnalysisData | null;
  onCompare: (pair: DragComparison | null) => void;
  onHover: (n: number | null) => void;
  onTileHover: (n: number | null) => void;
  onMerge: (a: number, b: number) => void;
  onWaveSplit: (
    cell: number,
    channel: number,
    sample: number,
    threshold: number,
  ) => void;
  onPopOut: (cell: number, x?: number, y?: number) => void;
  onPopPlot: (kind: "path" | "features", x: number, y: number) => void;
  ready: boolean;
  busy: boolean;
  progress: number;
  message: string;
  error: string;
  notice: string;
  drag: boolean;
  fileInput: RefObject<HTMLInputElement | null>;
  folderInput: RefObject<HTMLInputElement | null>;
  onImport: (f: File[]) => void;
  onTrial: (t: Trial) => void;
  onTet: (n: number) => void;
  onRecording: (t: Trial, n: number, c?: string) => void;
  onCut: (id: string) => void;
  downloadVersion: number;
  cutDownloads: CutDownloads;
  onPrepareCut: (t: Trial, e: Tetrode, c: CutFile) => void;
  onCutDrag: (event: React.DragEvent, t: Trial, e: Tetrode, c: CutFile) => void;
  onCell: (n: number) => void;
  onSource: (n: number, toggle: boolean) => void;
  onDest: (n: number) => void;
  onNewGroup: () => void;
  onTool: (s: string) => void;
  onToggle: (m: PlotMode, multiple: boolean) => void;
  onPanel: (p: "settings" | "history" | "headers" | "help") => void;
  onOperation: (type: string, p?: Record<string, unknown>) => void;
  onPolygon: (p: number[], a: number, b: number) => void;
  onDemo: () => void;
  onError: () => void;
  onNotice: () => void;
  onDrag: (v: boolean) => void;
  onDrop: (e: React.DragEvent) => void;
  children?: ReactNode;
}
const FULL_RANGE = [0, 1];
export function DesktopShell(p: Props) {
  const root = useRef<HTMLDivElement>(null),
    left = useRef<HTMLDivElement>(null),
    [layout, setLayout] = usePreference("panes", defaultLayout);
  const fitted = fitPaneLayout(
      layout,
      root.current?.clientWidth || innerWidth,
      left.current?.clientHeight || innerHeight - 35,
    ),
    split = fitted.left,
    rows = [fitted.files, fitted.features],
    timing = experimentTiming(p.data?.headers || {}, p.data?.duration || 0);
  useEffect(() => {
    const resize = () =>
      setLayout((saved) =>
        fitPaneLayout(
          saved,
          root.current?.clientWidth || innerWidth,
          left.current?.clientHeight || innerHeight - 35,
        ),
      );
    resize();
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    root.current
      ?.querySelector<HTMLElement>(".trial-block.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [p.trial?.id]);
  const pathCell = p.dragComparison?.source ?? p.hoverCell,
    primary = p.analysis?.cell === pathCell ? p.analysis : null,
    secondary =
      p.dragComparison?.target != null &&
      p.comparisonAnalysis?.cell === p.dragComparison.target
        ? p.comparisonAnalysis
        : null,
    // Stable unless the overlaid analyses change, so unrelated renders (hover,
    // progress, selection) do not repaint the full-resolution trajectory.
    pathLayers = useMemo(
      () =>
        [primary, secondary]
          .filter((a): a is AnalysisData => !!a)
          .map((a) => ({
            cell: a.cell,
            spikes: a.spikes,
            color: color(a.cell),
          })),
      [primary, secondary],
    );
  const ready = p.ready,
    active = p.trial?.tetrodes.find((t) => t.number === p.tetNum),
    numbers = [
      ...new Set(p.trials.flatMap((t) => t.tetrodes.map((t) => t.number))),
    ].sort((a, b) => a - b);
  const dragSplit = (
    e: React.PointerEvent,
    part: "horizontal" | "files" | "position",
  ) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (part === "horizontal") {
        const b = root.current!.getBoundingClientRect();
        setLayout((old) =>
          fitPaneLayout(
            { ...old, left: ev.clientX - b.left },
            b.width,
            left.current!.clientHeight,
          ),
        );
      } else {
        const b = left.current!.getBoundingClientRect();
        setLayout((old) =>
          fitPaneLayout(
            {
              ...old,
              ...(part === "files"
                ? { files: ev.clientY - b.top }
                : { features: b.bottom - ev.clientY }),
            },
            root.current!.clientWidth,
            b.height,
          ),
        );
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  return (
    <div
      className={`app desktop-app ${p.grabMode ? "grab-mode" : ""} ${p.splitPoint ? "splitting" : ""}`}
      data-ready={ready ? "true" : "false"}
      onDragOver={(e) => {
        e.preventDefault();
        if (
          e.dataTransfer.types.includes("Files") &&
          !e.dataTransfer.types.includes("application/x-waveform-cut")
        )
          p.onDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget) p.onDrag(false);
      }}
      onDrop={p.onDrop}
    >
      <input
        ref={p.fileInput}
        type="file"
        aria-label="Import recording files"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) p.onImport([...e.target.files]);
          e.target.value = "";
        }}
      />
      <input
        ref={p.folderInput}
        type="file"
        aria-label="Import recording folder"
        multiple
        hidden
        {...({ webkitdirectory: "" } as any)}
        onChange={(e) => {
          if (e.target.files) p.onImport([...e.target.files]);
          e.target.value = "";
        }}
      />
      {p.trials.length > 0 ? (
        <>
          <div
            className="desktop-toolbar"
            role="toolbar"
            aria-label="Waveform tools"
          >
            <button
              title="Open files [Ctrl/Cmd O]"
              aria-label="Browse files"
              onClick={() => p.fileInput.current?.click()}
            >
              <FolderOpen size={17} />
            </button>
            <button
              title="Open folder"
              aria-label="Open a folder"
              onClick={() => p.folderInput.current?.click()}
            >
              <Folder size={16} />
            </button>
            <span className="tool-separator" />
            <button
              title="Help / original video"
              aria-label="Help"
              onClick={() => p.onPanel("help")}
            >
              <HelpCircle size={17} />
            </button>
            <button
              title="Keyboard shortcuts [K]"
              aria-label="Keyboard shortcuts"
              onClick={() => p.onPanel("help")}
            >
              <Keyboard size={17} />
            </button>
            <span className="tool-separator" />
            <button
              title="Undo [Ctrl/Cmd Z]"
              aria-label="Undo"
              disabled={!ready || !p.data?.undo.length}
              onClick={() => p.onOperation("undo")}
            >
              <Undo2 size={18} />
            </button>
            <button
              title="Redo [Ctrl/Cmd Shift Z]"
              aria-label="Redo"
              disabled={!ready || !p.data?.redo.length}
              onClick={() => p.onOperation("redo")}
            >
              <Redo2 size={18} />
            </button>
            <button
              title="Edit history"
              aria-label="Edit history"
              onClick={() => p.onPanel("history")}
            >
              <History size={17} />
            </button>
            <span className="tool-separator" />
            <button
              title="File headers [H]"
              aria-label="File headers"
              onClick={() => p.onPanel("headers")}
            >
              <List size={17} />
            </button>
            <button
              title="Settings"
              aria-label="Settings"
              onClick={() => p.onPanel("settings")}
            >
              <Settings2 size={17} />
            </button>
            <span className="tool-separator" />
            {(
              ["waveforms", "spatial", "direction", "speed", "ac"] as PlotMode[]
            ).map((m) => (
              <button
                key={m}
                className={`plot-toggle ${p.shown[m] ? "checked" : ""}`}
                aria-label={
                  {
                    waveforms: "Waveforms",
                    spatial: "Spatial rate",
                    direction: "Head direction",
                    speed: "Speed",
                    ac: "Autocorrelation",
                  }[m]
                }
                aria-pressed={p.shown[m]}
                title={
                  {
                    waveforms: "Waveforms [W]",
                    spatial: "Spatial rate maps [R]",
                    direction: "Head direction [C]",
                    speed: "Speed tuning [V]",
                    ac: "Autocorrelation [T]",
                  }[m] + " · Shift-click to show several"
                }
                onClick={(e) => p.onToggle(m, e.shiftKey)}
              >
                {
                  {
                    waveforms: "WAV",
                    spatial: "RM",
                    direction: "DIR",
                    speed: "SPD",
                    ac: "TC",
                  }[m]
                }
              </button>
            ))}
            <div
              className="toolbar-status"
              role="group"
              aria-label="Recording details"
            >
              {p.data && (
                <span>
                  Spikes: <b>{p.data.n.toLocaleString()}</b> ·{" "}
                  {timing.durationText}
                  {p.data.waveSlots < p.data.n && (
                    <strong
                      className="toolbar-warning"
                      title={`Waveform tiles draw ${p.data.waveSlots.toLocaleString()} evenly spaced spikes of ${p.data.n.toLocaleString()}. Counts, edits and exports use every spike.`}
                    >
                      {" "}
                      · WARNING: waveforms sampled
                    </strong>
                  )}
                </span>
              )}
              <span>
                {p.busy ? (
                  <>
                    <progress max="1" value={p.progress} /> {p.message}
                  </>
                ) : p.data ? (
                  `${(p.data.residentBytes / 1048576).toFixed(0)} MB cached`
                ) : (
                  "Preparing…"
                )}
              </span>
            </div>
          </div>
          <div
            className="desktop-workspace"
            ref={root}
            style={{
              gridTemplateColumns: `minmax(240px,${split}px) 7px minmax(330px,1fr)`,
            }}
          >
            <div
              className="left-workspace"
              ref={left}
              style={{
                gridTemplateRows: `minmax(90px,${rows[0]}px) 6px minmax(90px,1fr) 6px minmax(160px,${rows[1]}px)`,
              }}
            >
              <section className="files-pane">
                <div className="tetrode-navigation">
                  <span>Tetrode:</span>
                  {numbers.map((n) => (
                    <button
                      key={n}
                      className={n === p.tetNum ? "active" : ""}
                      aria-label={String(n).padStart(2, "0")}
                      disabled={
                        !p.trial?.tetrodes.find((t) => t.number === n)?.file
                      }
                      onClick={() => p.onTet(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div className="trial-list">
                  {p.trials.map((t) => (
                    <div
                      key={t.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${t.name} ${t.tetrodes.length}`}
                      onClick={() => p.onTrial(t)}
                      onKeyDown={(e) => {
                        if (
                          e.target === e.currentTarget &&
                          (e.key === "Enter" || e.key === " ")
                        ) {
                          e.preventDefault();
                          e.stopPropagation();
                          p.onTrial(t);
                        }
                      }}
                      className={`trial-block ${t.id === p.trial?.id ? "selected" : ""}`}
                    >
                      <div className="trial-heading">
                        <span className="trial-name" title={t.folder || t.name}>
                          <b>Trial '{t.name}'</b>
                        </span>
                        <span className={`file-tag ${t.set ? "" : "missing"}`}>
                          ~.set
                        </span>
                        <span className={`file-tag ${t.pos ? "" : "missing"}`}>
                          ~.pos
                        </span>
                        {!!t.otherFiles?.length && (
                          <span
                            className="other-files"
                            title={`Other files (not loaded):\n${t.otherFiles.join("\n")}`}
                          >
                            {t.otherFiles.length} other{" "}
                            {t.otherFiles.length === 1 ? "file" : "files"}
                          </span>
                        )}
                        <small>{t.folder}</small>
                      </div>
                      <div className="trial-tetrodes">
                        {t.tetrodes.map((e) => (
                          <div
                            key={e.id}
                            className={`tetrode-file-block ${e.number === p.tetNum ? "expanded" : ""}`}
                            data-tetrode={e.number}
                          >
                            {e.file && (
                              <button
                                title={e.file.name}
                                aria-label={`${t.name} tetrode ${e.number}`}
                                className={
                                  t.id === p.trial?.id &&
                                  e.number === p.tetNum &&
                                  !p.cutId
                                    ? "active"
                                    : ""
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  p.onRecording(t, e.number, "");
                                }}
                              >
                                ~.{e.number}
                              </button>
                            )}
                            {e.cuts.map((c) => (
                              <button
                                key={c.id}
                                title={`${c.name}${c.local ? " (modified cut)" : ""}`}
                                data-local={c.local ? "true" : undefined}
                                data-export-ready={
                                  p.cutDownloads.entries.has(
                                    cutDownloadKey(e, c),
                                  )
                                    ? "true"
                                    : "false"
                                }
                                draggable
                                onMouseEnter={() => p.onPrepareCut(t, e, c)}
                                onPointerDown={() => p.onPrepareCut(t, e, c)}
                                onDragStart={(event) =>
                                  p.onCutDrag(event, t, e, c)
                                }
                                aria-label={c.name.replace(t.name, "~")}
                                className={`cut-file ${c.local ? "local-cut" : ""} ${t.id === p.trial?.id && e.number === p.tetNum && p.cutId === c.id ? "active" : ""}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  p.onRecording(t, e.number, c.id);
                                }}
                              >
                                {c.name.replace(t.name, "~")}
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
              <div
                className="pane-splitter"
                role="separator"
                aria-orientation="horizontal"
                title="Resize file and position panes"
                onPointerDown={(e) => dragSplit(e, "files")}
              />
              <section className="position-pane">
                <div className="position-content">
                  {p.analysis && p.trajectory && p.trial?.pos ? (
                    <>
                      <div className="position-info">
                        <div className="position-time" title={timing.date}>
                          {timing.text}
                          <br />
                          {timing.durationText}
                        </div>
                        <div className="position-speed">
                          <AnalysisPlot
                            data={p.analysis}
                            mode="speed"
                            maxRate={0}
                            positionSpeed
                            speedAlignment="left"
                            compact
                          />
                          <small className="speed-axis-limit">
                            {p.settings.speedMax} cm/s max
                          </small>
                        </div>
                      </div>
                      <div
                        className="position-path"
                        data-cell={primary?.cell}
                        data-cells={pathLayers.map((a) => a.cell).join(",")}
                        data-spikes={pathLayers.reduce(
                          (n, a) => n + a.spikes.length / 2,
                          0,
                        )}
                        data-source-spikes={
                          primary?.spikes.length ? primary.spikes.length / 2 : 0
                        }
                        data-target-spikes={
                          secondary?.spikes.length
                            ? secondary.spikes.length / 2
                            : 0
                        }
                        onPointerDownCapture={(e) => {
                          if (p.grabMode && e.button === 0) {
                            e.preventDefault();
                            e.stopPropagation();
                            p.onPopPlot("path", e.clientX, e.clientY);
                          }
                        }}
                      >
                        <PathPlot
                          trajectory={p.trajectory}
                          layers={pathLayers}
                        />
                      </div>
                    </>
                  ) : (
                    <span className="pane-placeholder">
                      {p.trial?.pos
                        ? "Processing position…"
                        : "Drop a matching .pos file for position plots."}
                    </span>
                  )}
                </div>
              </section>
              <div
                className="pane-splitter"
                role="separator"
                aria-orientation="horizontal"
                title="Resize position and feature panes"
                onPointerDown={(e) => dragSplit(e, "position")}
              />
              <section className="feature-pane">
                <GroupSelector
                  counts={p.data?.counts}
                  sources={p.sources}
                  dest={p.dest}
                  selected={p.cell}
                  disabled={!ready || !!p.swap || !!p.splitPoint}
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
                      tool={ready && !p.swap ? p.tool : "disabled"}
                      onPolygon={p.onPolygon}
                      onPick={(group, source, toggle) =>
                        source ? p.onSource(group, toggle) : p.onDest(group)
                      }
                    />
                  )}
                </div>
              </section>
            </div>
            <div
              className="desktop-splitter"
              role="separator"
              aria-orientation="vertical"
              title="Resize left panes and cell tile wall"
              onPointerDown={(e) => dragSplit(e, "horizontal")}
            />
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
                  posKey={
                    p.trial?.pos ? `${p.trial.id}|${fileId(p.trial.pos)}` : ""
                  }
                  selected={p.cell}
                  shown={p.shown}
                  onSelect={p.onCell}
                  splitPoint={p.splitPoint}
                  swap={p.swap}
                  feedback={p.tileFeedback}
                  onSwapGroup={p.onSwapGroup}
                  grabMode={p.grabMode}
                  busy={!ready}
                  onCompare={p.onCompare}
                  onHover={p.onTileHover}
                  onMerge={p.onMerge}
                  onWaveSplit={p.onWaveSplit}
                  onPopOut={p.onPopOut}
                />
              ) : (
                <div className="pane-placeholder">
                  {p.message || "Loading recording…"}
                </div>
              )}
            </section>
          </div>
        </>
      ) : (
        <main className="start-screen">
          <div className="start-drop">
            <h1 className={p.drag ? "drop-title-wobble" : ""}>
              drag &amp; drop files here
            </h1>
            <p className="recognised-types">
              the following types of data files are recognised:
            </p>
            <div className="supported-formats">
              <code>.set</code>
              <code>.pos</code>
              <code>.1, .2, …</code>
              <code>.cut</code>
              <code>.clu.N</code>
            </div>
            <p className="drop-extra">
              You can drag further files onto the window at any point.
              <br />
              Other file types will be ignored.
            </p>
            <p className="start-actions">
              <button
                aria-label="Browse files"
                onClick={() => p.fileInput.current?.click()}
              >
                Choose files
              </button>
              <span> · </span>
              <button onClick={() => p.folderInput.current?.click()}>
                Choose folder
              </button>
              <span> · </span>
              <a
                href="https://github.com/ChenNeuroscience/waveform"
                target="_blank"
                rel="noreferrer"
              >
                GitHub / more information
              </a>
            </p>
            <a
              className="original-video"
              href="https://www.youtube.com/watch?v=36o69CPu-1E"
              target="_blank"
              rel="noreferrer"
            >
              <img src={video} alt="Watch the original Waveform introduction" />
              <span>Original video introduction ↗</span>
            </a>
            <button
              className="demo-files"
              draggable={false}
              aria-label="Try it now with simulated data"
              disabled={p.busy}
              onClick={p.onDemo}
            >
              <span className="demo-file-stack" aria-hidden="true">
                <span className="demo-file-card">.pos</span>
                <span className="demo-file-card">.cut</span>
                <span className="demo-file-card">.1</span>
                <svg viewBox="0 0 100 40">
                  <path d="M35 4 L35 28 L42 22 L49 35 L54 32 L47 20 L59 20 Z M25 4 L20 0 M23 14 H16" />
                </svg>
              </span>
              <span>
                <b>Try it now with simulated data</b>
                <small>Click here to explore</small>
                <small>
                  {new URLSearchParams(location.search).get("demo") === "quick"
                    ? "Quick preview"
                    : new URLSearchParams(location.search).get("demo") ===
                        "stress"
                      ? "9 million spikes · 100 cells · stress test"
                      : "~50k spikes/tetrode · 20 minutes · 5 trials"}
                </small>
              </span>
            </button>
            {p.busy && (
              <div className="demo-progress" role="status">
                <progress max="1" value={p.progress} />
                {p.message}
              </div>
            )}
          </div>
        </main>
      )}
      {(p.error || p.notice) && (
        <div
          className={`desktop-notice ${p.error ? "error" : ""}`}
          role={p.error ? "alert" : "status"}
        >
          <span>{p.error || p.notice}</span>
          <button
            aria-label={p.error ? "Dismiss error" : "Dismiss notification"}
            onClick={p.error ? p.onError : p.onNotice}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {p.drag && p.trials.length > 0 && (
        <div className="drag-overlay">
          <p className="drop-title-wobble">drag &amp; drop files here</p>
          <small>.set · .pos · .1, .2, … · .cut · .clu.N</small>
        </div>
      )}
      {p.children}
    </div>
  );
}
