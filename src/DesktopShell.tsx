import { useRef, useState, type ReactNode, type RefObject } from "react";
import {
  FolderOpen,
  Folder,
  Undo2,
  Redo2,
  Keyboard,
  Settings2,
  History,
  List,
  Upload,
  Search,
  Scissors,
  PenLine,
  MousePointer2,
  GitMerge,
  ArrowLeftRight,
  Pin,
  Copy,
  ImageDown,
  Plus,
  X,
  HelpCircle,
} from "lucide-react";
import { Clusters, AnalysisPlot, WaveformGate } from "./plots";
import { TileWall, type VisiblePlots } from "./TileWall";
import {
  color,
  fileId,
  type Trial,
  type ViewData,
  type AnalysisData,
  type Settings,
  type PlotMode,
  type SplitPoint,
} from "./types";
import video from "../img/demo_youtube.png";
interface Props {
  trials: Trial[];
  trial?: Trial;
  tetNum: number;
  cutId: string;
  data: ViewData | null;
  analysis: AnalysisData | null;
  settings: Settings;
  cell: number;
  sources: number[];
  dest: number;
  tool: string;
  isolate: boolean;
  range: number[];
  shown: VisiblePlots;
  splitPoint: SplitPoint | null;
  grabMode: boolean;
  hoverCell: number | null;
  onHover: (n: number | null) => void;
  onMerge: (a: number, b: number) => void;
  onWaveSplit: (
    cell: number,
    channel: number,
    sample: number,
    threshold: number,
  ) => void;
  onPopOut: (cell: number, x?: number, y?: number) => void;
  onPopPlot: (kind: "path" | "features", x: number, y: number) => void;
  busy: boolean;
  progress: number;
  message: string;
  error: string;
  notice: string;
  drag: boolean;
  filter: string;
  sort: boolean;
  fileInput: RefObject<HTMLInputElement | null>;
  folderInput: RefObject<HTMLInputElement | null>;
  onImport: (f: File[]) => void;
  onTrial: (t: Trial) => void;
  onTet: (n: number) => void;
  onRecording: (t: Trial, n: number, c?: string) => void;
  onCut: (id: string) => void;
  onCell: (n: number) => void;
  onSources: (n: number[]) => void;
  onDest: (n: number) => void;
  onTool: (s: string) => void;
  onIsolate: (v: boolean) => void;
  onRange: (n: number[]) => void;
  onToggle: (m: PlotMode) => void;
  onPanel: (p: "settings" | "history" | "headers" | "help") => void;
  onOperation: (type: string, p?: Record<string, unknown>) => void;
  onEdit: (action: string) => void;
  onPolygon: (p: number[], a: number, b: number) => void;
  onExport: () => void;
  onSettings: (k: keyof Settings, v: any) => void;
  onDemo: () => void;
  onFilter: (s: string) => void;
  onSort: () => void;
  onError: () => void;
  onNotice: () => void;
  onDrag: (v: boolean) => void;
  onDrop: (e: React.DragEvent) => void;
  onPin: () => void;
  onCopy: () => void;
  onImage: () => void;
  children?: ReactNode;
}
const time = (n: number) =>
  `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
export function DesktopShell(p: Props) {
  const root = useRef<HTMLDivElement>(null),
    left = useRef<HTMLDivElement>(null),
    [split, setSplit] = useState(350),
    [rows, setRows] = useState([200, 300]);
  const ready = !!p.data && !p.busy,
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
        setSplit(Math.max(240, Math.min(b.width - 337, ev.clientX - b.left)));
      } else {
        const b = left.current!.getBoundingClientRect();
        setRows((old) =>
          part === "files"
            ? [
                Math.max(
                  90,
                  Math.min(b.height - old[1] - 102, ev.clientY - b.top),
                ),
                old[1],
              ]
            : [
                old[0],
                Math.max(
                  160,
                  Math.min(b.height - old[0] - 102, b.bottom - ev.clientY),
                ),
              ],
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
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) p.onDrag(true);
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
                  }[m]
                }
                onClick={() => p.onToggle(m)}
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
            <span className="toolbar-title">
              {p.trial?.name || "Waveform"}
              {p.data?.dirty ? " *" : ""}
            </span>
            <button
              aria-label="Export cut"
              title="Export .cut [Ctrl/Cmd S]"
              disabled={!ready}
              onClick={p.onExport}
            >
              <Upload size={15} />
              Export cut
            </button>
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
                      className={`trial-block ${t.id === p.trial?.id ? "selected" : ""}`}
                    >
                      <div className="trial-heading">
                        <button
                          className="trial-name"
                          aria-label={`${t.name} ${t.tetrodes.length}`}
                          title={t.folder || t.name}
                          onClick={() => p.onTrial(t)}
                        >
                          <b>Trial '{t.name}'</b>
                        </button>
                        <button
                          disabled={!t.set}
                          className="file-tag"
                          onClick={() => {
                            p.onTrial(t);
                            p.onPanel("headers");
                          }}
                        >
                          ~.set
                        </button>
                        <button
                          disabled={!t.pos}
                          className="file-tag"
                          onClick={() => p.onTrial(t)}
                        >
                          ~.pos
                        </button>
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
                                  t.id === p.trial?.id && e.number === p.tetNum
                                    ? "active"
                                    : ""
                                }
                                onClick={() => p.onRecording(t, e.number)}
                              >
                                ~.{e.number}
                              </button>
                            )}
                            {e.file && e.number === p.tetNum && (
                              <button
                                title="Unsorted spikes"
                                className={
                                  t.id === p.trial?.id && !p.cutId
                                    ? "active"
                                    : ""
                                }
                                onClick={() => p.onRecording(t, e.number, "")}
                              >
                                uncut
                              </button>
                            )}
                            {e.cuts.map((c) => (
                              <button
                                key={c.id}
                                title={c.name}
                                aria-label={c.name.replace(t.name, "~")}
                                className={`cut-file ${t.id === p.trial?.id && e.number === p.tetNum && p.cutId === c.id ? "active" : ""}`}
                                onClick={() => p.onRecording(t, e.number, c.id)}
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
                title="Resize file and position panes"
                onPointerDown={(e) => dragSplit(e, "files")}
              >
                •••
              </div>
              <section className="position-pane">
                <div className="pane-caption">
                  <span>
                    {p.hoverCell === null
                      ? "Position"
                      : `Position / spikes · cell ${p.hoverCell}`}
                  </span>
                  <span>
                    {time((p.data?.duration || 0) * p.range[0])}–
                    {time((p.data?.duration || 0) * p.range[1])}
                  </span>
                  <label>
                    Start
                    <input
                      aria-label="Time window start"
                      type="range"
                      min="0"
                      max="1"
                      step=".001"
                      value={p.range[0]}
                      onChange={(e) =>
                        p.onRange([
                          Math.min(+e.target.value, p.range[1]),
                          p.range[1],
                        ])
                      }
                    />
                  </label>
                  <label>
                    End
                    <input
                      aria-label="Time window end"
                      type="range"
                      min="0"
                      max="1"
                      step=".001"
                      value={p.range[1]}
                      onChange={(e) =>
                        p.onRange([
                          p.range[0],
                          Math.max(+e.target.value, p.range[0]),
                        ])
                      }
                    />
                  </label>
                  <button onClick={() => p.onRange([0, 1])}>Reset</button>
                </div>
                <div className="position-content">
                  {p.analysis && p.trial?.pos ? (
                    <>
                      <div className="position-speed">
                        <AnalysisPlot
                          data={p.analysis}
                          mode="speed"
                          maxRate={0}
                          compact
                        />
                        <small>80 cm/s</small>
                      </div>
                      <div
                        className="position-path"
                        data-cell={
                          p.analysis.cell === p.hoverCell
                            ? p.hoverCell
                            : undefined
                        }
                        data-spikes={
                          p.analysis.cell === p.hoverCell
                            ? p.analysis.spikes.length / 2
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
                        <AnalysisPlot
                          data={
                            p.analysis.cell === p.hoverCell
                              ? p.analysis
                              : { ...p.analysis, spikes: new Float32Array() }
                          }
                          mode="path"
                          maxRate={0}
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
                title="Resize position and feature panes"
                onPointerDown={(e) => dragSplit(e, "position")}
              >
                •••
              </div>
              <section className="feature-pane">
                <div className="feature-tools">
                  <button
                    className={p.tool === "select" ? "active" : ""}
                    title="Select"
                    onClick={() => p.onTool("select")}
                  >
                    <MousePointer2 size={14} />
                  </button>
                  <button
                    className={p.tool === "lasso" ? "active" : ""}
                    aria-label="Lasso cut"
                    title="Lasso source spikes [L]"
                    onClick={() => p.onTool("lasso")}
                  >
                    <Scissors size={14} />
                  </button>
                  <button
                    className={p.tool === "brush" ? "active" : ""}
                    aria-label="Paint source spikes"
                    title="Paint source spikes"
                    onClick={() => p.onTool("brush")}
                  >
                    <PenLine size={14} />
                  </button>
                  <span>
                    Source: {p.sources.length ? p.sources.join(", ") : "none"} →
                  </span>
                  <label>
                    Destination
                    <input
                      aria-label="Destination cell"
                      type="number"
                      min="0"
                      max="1023"
                      value={p.dest}
                      onChange={(e) =>
                        p.onDest(Math.max(0, Math.min(1023, +e.target.value)))
                      }
                    />
                  </label>
                  <button
                    aria-label="Next empty cell"
                    title="Next empty cell"
                    onClick={() =>
                      p.onDest(
                        Math.max(
                          1,
                          p.data?.counts.findIndex((n, i) => i > 0 && !n) || 1,
                        ),
                      )
                    }
                  >
                    <Plus size={13} />
                  </button>
                  <button
                    aria-label="Merge"
                    title={`Merge cell ${p.cell} into ${p.dest}`}
                    disabled={!ready || p.cell === p.dest}
                    onClick={() => p.onEdit("merge")}
                  >
                    <GitMerge size={13} />
                  </button>
                  <button
                    aria-label="Swap"
                    title={`Swap ${p.cell} and ${p.dest}`}
                    disabled={!ready || p.cell === p.dest}
                    onClick={() => p.onEdit("swap")}
                  >
                    <ArrowLeftRight size={13} />
                  </button>
                </div>
                <div className="feature-group-strip">
                  {p.data &&
                    Array.from(p.data.counts, (n, i) => ({ n, i }))
                      .filter((c) => c.n)
                      .map((c) => (
                        <button
                          key={c.i}
                          className={c.i === p.cell ? "active" : ""}
                          aria-label={`Focus cell ${c.i}`}
                          title={`${c.n.toLocaleString()} spikes; click selects source`}
                          style={{
                            background: c.i ? color(c.i) : "#eee",
                            color: c.i ? "white" : "black",
                          }}
                          onClick={() => p.onCell(c.i)}
                        >
                          {c.i}
                        </button>
                      ))}
                </div>
                <div className="feature-options">
                  <label>
                    <input
                      type="checkbox"
                      checked={p.isolate}
                      onChange={(e) => p.onIsolate(e.target.checked)}
                    />
                    isolate
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={p.settings.drift}
                      onChange={(e) => p.onSettings("drift", e.target.checked)}
                    />
                    drift
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={p.settings.density}
                      onChange={(e) =>
                        p.onSettings("density", e.target.checked)
                      }
                    />
                    density
                  </label>
                  <small>
                    {p.data
                      ? `${Math.min(p.data.n, p.settings.budget).toLocaleString()} / ${p.data.n.toLocaleString()} displayed`
                      : "Preparing…"}{" "}
                    · cuts use all spikes
                  </small>
                </div>
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
                      range={p.range}
                      tool={ready ? p.tool : "select"}
                      onPolygon={p.onPolygon}
                    />
                  )}
                </div>
                <WaveformGate
                  disabled={!ready || !p.sources.length}
                  onGate={(channel, sample, threshold, above) =>
                    p.onOperation("edit", {
                      action: "gate",
                      sources: p.sources,
                      dest: p.dest,
                      channel,
                      sample,
                      threshold,
                      above,
                      description: `Waveform Ch ${channel + 1} sample ${sample} ${above ? "≥" : "<"} ${threshold} → ${p.dest}`,
                    })
                  }
                />
              </section>
            </div>
            <div
              className="desktop-splitter"
              title="Resize left panes and cell tile wall"
              onPointerDown={(e) => dragSplit(e, "horizontal")}
            >
              ⋮
            </div>
            <section className="right-workspace">
              <div className="tile-wall-tools">
                <b>Cells</b>
                <span>
                  {p.data?.counts.filter((n, i) => i > 0 && n > 0).length || 0}
                </span>
                <span className="small-separator" />
                <Search size={12} />
                <input
                  aria-label="Find cell"
                  placeholder="cell #"
                  value={p.filter}
                  onChange={(e) => p.onFilter(e.target.value)}
                />
                <button
                  title="Sort by spike count"
                  aria-label="Sort cells by count"
                  onClick={p.onSort}
                >
                  {p.sort ? "Count ↓" : "Cell #"}
                </button>
                <span className="tools-spacer" />
                <button
                  title="Pin current cell"
                  aria-label="Pin cell snapshot"
                  onClick={p.onPin}
                >
                  <Pin size={13} />
                </button>
                <button
                  title="Copy current cell"
                  aria-label="Copy cell plot"
                  onClick={p.onCopy}
                >
                  <Copy size={13} />
                </button>
                <button
                  title="Save current cell image"
                  aria-label="Export plot image"
                  onClick={p.onImage}
                >
                  <ImageDown size={13} />
                </button>
              </div>
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
                  filter={p.filter}
                  sort={p.sort}
                  onSelect={p.onCell}
                  splitPoint={p.splitPoint}
                  grabMode={p.grabMode}
                  busy={!ready}
                  onHover={p.onHover}
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
            <h1>drag &amp; drop files here</h1>
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
            <button className="demo-link" onClick={p.onDemo}>
              Explore a synthetic demo
            </button>
            <small>
              Files are processed locally and stay on this computer.
            </small>
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
      <footer className="desktop-status">
        <span>
          {p.busy
            ? p.message
            : p.data
              ? `${p.data.name}${p.data.dirty ? " *" : ""}`
              : "Drop files to begin"}
        </span>
        {p.busy && <progress max="1" value={p.progress} />}
        <span className="status-spacer" />
        {p.data && (
          <>
            <span>
              Spikes: <b>{p.data.n.toLocaleString()}</b>
            </span>
            <span>{time(p.data.duration)}</span>
            <span>{(p.data.residentBytes / 1048576).toFixed(0)} MB cached</span>
          </>
        )}
        <span>Local files</span>
      </footer>
      {p.drag && (
        <div className="drag-overlay">
          <p>Drop LTX recording files</p>
          <small>.set · .pos · .1, .2, … · .cut · .clu.N</small>
        </div>
      )}
      {p.children}
    </div>
  );
}
